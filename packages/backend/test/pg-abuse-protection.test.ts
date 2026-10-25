import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../../../scripts/test-database.mjs";
import { DEFAULT_ABUSE_LIMITS, type AbuseLimits } from "../src/abuse-protection.js";
import { createPostgresProtection, resetIpChatWindow } from "../src/pg-abuse-protection.js";
import { runMigrations } from "../src/migrate.js";

describe("Postgres 跨实例防刷", () => {
  const poolA = new Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5000 });
  const poolB = new Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5000 });
  const guard = (pool: Pool, limits: Partial<AbuseLimits> = {}) => createPostgresProtection(pool, {
    rateWindowMs: 60000, rateMax: 3, limits: { ...DEFAULT_ABUSE_LIMITS, ...limits },
  });
  const admission = (ip = randomUUID(), visitorId = randomUUID(), sessionId = randomUUID()) => ({ ip, visitorId, sessionId });

  beforeAll(async () => { await runMigrations(testDatabaseUrl()); });
  beforeEach(async () => { await poolA.query("TRUNCATE request_rate_windows, chat_daily_usage, active_chat_leases, ip_chat_windows"); });
  afterAll(async () => { await Promise.all([poolA.end(), poolB.end()]); });

  it("两个连接池竞争同一 IP 窗口只放行限额数量，重建实例不重置", async () => {
    const a = guard(poolA), b = guard(poolB);
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).rate("chat-ip", "203.0.113.10")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    await expect(guard(poolB).rate("chat-ip", "203.0.113.10")).rejects.toMatchObject({ code: "rate_limited" });
    const rows = await poolA.query("SELECT identity_hash, hits FROM request_rate_windows");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].hits).toBe(3);
    expect(rows.rows[0].identity_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("跨实例并发准入严格受全站名额控制，被拒绝的请求不扣每日额度", async () => {
    const a = guard(poolA), b = guard(poolB);
    const results = await Promise.allSettled(Array.from({ length: 18 }, (_, i) => (i % 2 ? a : b).acquire(admission())));
    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(DEFAULT_ABUSE_LIMITS.maxConcurrent);
    const count = await poolA.query("SELECT requests FROM chat_daily_usage WHERE scope = 'global'");
    expect(count.rows[0].requests).toBe(DEFAULT_ABUSE_LIMITS.maxConcurrent);
    const first = accepted[0]!;
    if (first.status === "fulfilled") await b.release(first.value);
    await expect(a.acquire(admission())).resolves.toHaveProperty("id");
  });

  it("单 IP 和访客并发限制作用于所有实例，重复会话返回冲突", async () => {
    const a = guard(poolA), b = guard(poolB);
    const input = admission();
    await a.acquire(input);
    await expect(b.acquire(input)).rejects.toMatchObject({ status: 409 });
    await expect(b.acquire(admission("new-ip", input.visitorId))).rejects.toMatchObject({ code: "visitor_busy" });
    await b.acquire(admission(input.ip));
    await expect(a.acquire(admission(input.ip))).rejects.toMatchObject({ code: "ip_busy" });
  });

  it("每日全站计数持久化，换 IP、换访客、重建实例都不能重置", async () => {
    const a = guard(poolA, { dailyRequests: 2 });
    await a.release(await a.acquire(admission()));
    await a.release(await a.acquire(admission()));
    await expect(guard(poolB, { dailyRequests: 2 }).acquire(admission())).rejects.toMatchObject({ code: "daily_quota" });
    const count = await poolA.query("SELECT requests FROM chat_daily_usage WHERE scope = 'global'");
    expect(count.rows[0].requests).toBe(2);
  });

  it("单 IP 每日额度防止换 cookie，访客额度防止同一访客更换 IP", async () => {
    const a = guard(poolA, { dailyRequestsPerIp: 1, dailyRequestsPerVisitor: 1 });
    const input = admission();
    await a.release(await a.acquire(input));
    await expect(a.acquire(admission(input.ip))).rejects.toMatchObject({ code: "daily_quota" });
    await expect(a.acquire(admission("new-ip", input.visitorId))).rejects.toMatchObject({ code: "daily_quota" });
    const count = await poolA.query("SELECT requests FROM chat_daily_usage WHERE scope = 'global'");
    expect(count.rows[0].requests).toBe(1);
  });

  it("过期租约回收且不能复活，停止信号可由另一实例发送", async () => {
    const a = guard(poolA), b = guard(poolB);
    const input = admission();
    const permit = await a.acquire(input);
    expect(await b.requestStop(randomUUID(), input.sessionId)).toBe(false);
    expect(await b.requestStop(input.visitorId, input.sessionId)).toBe(true);
    expect(await a.renew(permit)).toBe("stop");
    await poolA.query("UPDATE active_chat_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [permit.id]);
    await expect(a.renew(permit)).rejects.toMatchObject({ code: "lease_lost" });
    const next = await b.acquire(input);
    await a.release(permit);
    expect(await b.renew(next)).toBe("active");
  });

  it("准入事务中途失败不留下配额扣款或并发名额", async () => {
    const a = guard(poolA);
    await expect(a.acquire({ ...admission(), sessionId: "invalid-uuid" })).rejects.toThrow();
    const daily = await poolA.query("SELECT * FROM chat_daily_usage");
    const leases = await poolA.query("SELECT * FROM active_chat_leases");
    expect(daily.rowCount).toBe(0);
    expect(leases.rowCount).toBe(0);
    expect((await poolA.query("SELECT * FROM ip_chat_windows")).rowCount).toBe(0);
  });

  it("同一 IP 跨实例共享唯一时段，邮箱/会话/重启/自然日配额重置都不能延长", async () => {
    const ip = "203.0.113.1", a = guard(poolA), b = guard(poolB);
    const permits = await Promise.all([a.acquire(admission(ip)), b.acquire(admission(ip))]);
    const windows = await poolA.query("SELECT * FROM ip_chat_windows");
    expect(windows.rowCount).toBe(1);
    expect(windows.rows[0].ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(windows.rows[0].expires_at.getTime() - windows.rows[0].started_at.getTime()).toBeCloseTo(900_000, -1);
    await Promise.all(permits.map((permit) => a.release(permit)));
    await b.release(await b.acquire(admission(ip)));
    expect((await poolA.query("SELECT expires_at FROM ip_chat_windows")).rows[0].expires_at).toEqual(windows.rows[0].expires_at);
    await poolA.query("UPDATE ip_chat_windows SET expires_at = clock_timestamp() - interval '2 days'");
    // 未来自然日的请求计数即使已经清理，永久时段仍保留。
    await poolA.query("TRUNCATE chat_daily_usage");
    await expect(guard(poolB).acquire(admission(ip))).rejects.toMatchObject({ code: "ip_time_exhausted", retryAfter: null });
    expect((await poolA.query("SELECT * FROM chat_daily_usage")).rowCount).toBe(0);
    expect((await poolA.query("SELECT * FROM active_chat_leases")).rowCount).toBe(0);
    await expect(a.acquire(admission("203.0.113.2"))).resolves.toHaveProperty("id");
  });

  it("数据库时段到期后不允许续租，不依赖应用的本地截止时间", async () => {
    const a = guard(poolA), permit = await a.acquire(admission());
    permit.ipWindowDeadline = Date.now() + 9999999;
    await poolB.query("UPDATE ip_chat_windows SET expires_at = clock_timestamp() - interval '1 second'");
    await expect(a.renew(permit)).rejects.toMatchObject({ code: "ip_time_exhausted" });
  });

  it("手动解除仅恢复指定 IP 的时段，撤销旧租约且保留每日请求计数", async () => {
    const a = guard(poolA), b = guard(poolB);
    const first = await a.acquire(admission("203.0.113.10"));
    const other = await b.acquire(admission("203.0.113.11"));
    await poolA.query("UPDATE ip_chat_windows SET expires_at = clock_timestamp() - interval '1 second'");
    const before = (await poolA.query("SELECT requests FROM chat_daily_usage WHERE scope = 'global'")).rows[0].requests;
    expect(await resetIpChatWindow(poolB, "::ffff:203.0.113.10")).toBe(true);
    await expect(a.renew(first)).rejects.toMatchObject({ code: "lease_lost" });
    await b.release(other);
    await expect(b.acquire(admission("203.0.113.11"))).rejects.toMatchObject({ code: "ip_time_exhausted" });
    expect((await poolA.query("SELECT requests FROM chat_daily_usage WHERE scope = 'global'")).rows[0].requests).toBe(before);
    await expect(a.acquire(admission("203.0.113.10"))).resolves.toHaveProperty("id");
    expect(await resetIpChatWindow(poolA, "203.0.113.99")).toBe(false);
    await expect(resetIpChatWindow(poolA, "--all")).rejects.toThrow("请输入有效");
  });
});
