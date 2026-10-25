import { describe, expect, it } from "vitest";
import { createMemoryProtection, DEFAULT_ABUSE_LIMITS, normalizeClientIp, plaintextClientIp, ProtectionError, quotaDay, type AbuseLimits } from "../src/abuse-protection.js";

const admission = (visitorId = "visitor", ip = "127.0.0.1", sessionId = crypto.randomUUID()) => ({ visitorId, ip, sessionId });
const guard = (overrides: Partial<AbuseLimits> = {}, now?: () => number) => createMemoryProtection({
  rateWindowMs: 1000, rateMax: 2, limits: { ...DEFAULT_ABUSE_LIMITS, ...overrides },
}, now);

describe("防刷策略", () => {
  it("同一 IP 共享首次提问后的连续时段，换访客和自然日都不重置", async () => {
    let now = Date.UTC(2026, 9, 23);
    const protection = guard({}, () => now);
    const first = await protection.acquire(admission("email-a"));
    expect(first.ipWindowDeadline).toBe(now + 15 * 60_000);
    await protection.release(first);
    now += 14 * 60_000;
    const second = await protection.acquire(admission("email-b"));
    expect(second.ipWindowDeadline).toBe(first.ipWindowDeadline);
    await protection.release(second);
    now += 60_000;
    await expect(protection.acquire(admission("email-c"))).rejects.toMatchObject({ code: "ip_time_exhausted", retryAfter: null });
    now += 2 * 86400_000;
    await expect(protection.acquire(admission("email-d"))).rejects.toMatchObject({ code: "ip_time_exhausted" });
    await expect(protection.acquire(admission("email-d", "other-ip"))).resolves.toHaveProperty("id");
  });

  it("设置恢复期后，到期时段过了这段时间会重新开放", async () => {
    let now = 0;
    const protection = guard({ ipChatWindowMs: 100, ipChatCooldownMs: 50 }, () => now);
    await protection.release(await protection.acquire(admission()));
    now = 100;
    await expect(protection.acquire(admission())).rejects.toMatchObject({ code: "ip_time_exhausted" });
    now = 149;
    await expect(protection.acquire(admission())).rejects.toMatchObject({ code: "ip_time_exhausted" });
    now = 150;
    const again = await protection.acquire(admission());
    expect(again.ipWindowDeadline).toBe(250);
  });

  it("站长登录按 15 分钟窗口单独计数，不影响聊天限流", async () => {
    const protection = guard();
    for (let i = 0; i < 10; i += 1) await protection.rate("admin-login-ip", "203.0.113.8");
    await expect(protection.rate("admin-login-ip", "203.0.113.8")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(protection.rate("chat-ip", "203.0.113.8")).resolves.toBeUndefined();
  });

  it("时段到期时不再续租，释放租约也不能重新获得时段", async () => {
    let now = 0;
    const protection = guard({ ipChatWindowMs: 100, leaseMs: 1000 }, () => now);
    const permit = await protection.acquire(admission());
    now = 100;
    await expect(protection.renew(permit)).rejects.toMatchObject({ code: "ip_time_exhausted" });
    await protection.release(permit);
    await expect(protection.acquire(admission())).rejects.toMatchObject({ code: "ip_time_exhausted" });
  });

  it("统一 IPv6 拼写和 IPv4 映射地址，拒绝非 IP 输入", () => {
    expect(normalizeClientIp("::ffff:203.0.113.1")).toBe("203.0.113.1");
    expect(normalizeClientIp("::ffff:cb00:7101")).toBe("203.0.113.1");
    expect(normalizeClientIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeClientIp("203.0.113.1")).toBe("203.0.113.1");
    expect(normalizeClientIp("not-an-ip")).toBe("unknown");
    expect(normalizeClientIp("fe80::1%eth0")).toBe("unknown");
    expect(plaintextClientIp("::ffff:203.0.113.1")).toBe("203.0.113.1");
    expect(plaintextClientIp(" 2001:0DB8::1 ")).toBe("2001:db8::1");
    expect(plaintextClientIp("unknown")).toBeNull();
    expect(plaintextClientIp("not-an-ip")).toBeNull();
    expect(plaintextClientIp(null)).toBeNull();
    expect(plaintextClientIp("")).toBeNull();
  });
  it("IP 和访客分别限流，换访客不会重置 IP 窗口", async () => {
    let now = 0;
    const protection = guard({}, () => now);
    await protection.rate("chat-ip", "ip");
    await protection.rate("chat-ip", "ip");
    await expect(protection.rate("chat-ip", "ip")).rejects.toMatchObject({ status: 429 });
    await protection.rate("chat-visitor", "new-visitor");
    await expect(protection.rate("chat-ip", "ip")).rejects.toBeInstanceOf(ProtectionError);
    now = 1001;
    await expect(protection.rate("chat-ip", "ip")).resolves.toBeUndefined();
  });

  it("并发竞争只放行全站额度以内的请求", async () => {
    const protection = guard({ maxConcurrent: 2, maxConcurrentPerIp: 10 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => protection.acquire(admission(`visitor-${i}`))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const first = results.find((result) => result.status === "fulfilled")!;
    if (first.status === "fulfilled") await protection.release(first.value);
    await expect(protection.acquire(admission("another"))).resolves.toHaveProperty("id");
  });

  it("同一访客不能通过新会话或更换 IP 占用多个名额", async () => {
    const protection = guard();
    const input = admission();
    await protection.acquire(input);
    await expect(protection.acquire({ ...input })).rejects.toMatchObject({ status: 409, code: "session_busy" });
    await expect(protection.acquire(admission("visitor", "other-ip"))).rejects.toMatchObject({ code: "visitor_busy" });
  });

  it("单 IP 的并发和每日额度不因更换 cookie 而重置", async () => {
    const protection = guard({ dailyRequestsPerIp: 2, maxConcurrentPerIp: 1 });
    const first = await protection.acquire(admission("a"));
    await expect(protection.acquire(admission("b"))).rejects.toMatchObject({ code: "ip_busy" });
    await protection.release(first);
    const second = await protection.acquire(admission("b"));
    await protection.release(second);
    await expect(protection.acquire(admission("c"))).rejects.toMatchObject({ code: "daily_quota" });
  });

  it("结束或失败释放并发名额，不返还已接受请求的每日额度", async () => {
    const protection = guard({ dailyRequests: 1 });
    const first = await protection.acquire(admission());
    await protection.release(first);
    await expect(protection.acquire(admission("new", "new-ip"))).rejects.toMatchObject({ code: "daily_quota" });
  });

  it("租约自动过期，不允许旧实例续租复活；停止请求校验归属", async () => {
    let now = 0;
    const protection = guard({ leaseMs: 100 }, () => now);
    const input = admission();
    const first = await protection.acquire(input);
    expect(await protection.requestStop("stranger", input.sessionId)).toBe(false);
    expect(await protection.requestStop(input.visitorId, input.sessionId)).toBe(true);
    expect(await protection.renew(first)).toBe("stop");
    now = 101;
    const next = await protection.acquire(input);
    await expect(protection.renew(first)).rejects.toMatchObject({ code: "lease_lost" });
    await protection.release(first);
    expect(await protection.renew(next)).toBe("active");
  });

  it("解除指定 IP 的时段后重新计时，不恢复其他 IP，也不清每日额度", async () => {
    let now = 0;
    const protection = guard({ ipChatWindowMs: 100, dailyRequestsPerIp: 2 }, () => now);
    await protection.release(await protection.acquire(admission("a", "203.0.113.1")));
    await protection.release(await protection.acquire(admission("b", "203.0.113.2")));
    now = 100;
    await expect(protection.acquire(admission("c", "203.0.113.1"))).rejects.toMatchObject({ code: "ip_time_exhausted" });
    expect(await protection.resetIpWindow("::ffff:203.0.113.1")).toBe(true);
    const again = await protection.acquire(admission("c", "203.0.113.1"));
    expect(again.ipWindowDeadline).toBe(now + 100);
    await protection.release(again);
    await expect(protection.acquire(admission("e", "203.0.113.1"))).rejects.toMatchObject({ code: "daily_quota" });
    await expect(protection.acquire(admission("d", "203.0.113.2"))).rejects.toMatchObject({ code: "ip_time_exhausted" });
    expect(await protection.resetIpWindow("203.0.113.9")).toBe(false);
    await expect(protection.resetIpWindow("not-an-ip")).rejects.toThrow(/有效/);
  });

  it("按指定时区在自然日边界重置每日额度", async () => {
    let now = Date.UTC(2026, 9, 23, 15, 59, 59);
    const protection = guard({ dailyRequests: 1 }, () => now);
    expect(quotaDay(now, "Asia/Singapore")).toBe("2026-10-23");
    await protection.release(await protection.acquire(admission()));
    now += 2000;
    expect(quotaDay(now, "Asia/Singapore")).toBe("2026-10-24");
    await expect(protection.acquire(admission())).resolves.toHaveProperty("id");
  });
});
