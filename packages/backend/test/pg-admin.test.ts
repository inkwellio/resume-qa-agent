import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl } from "../../../scripts/test-database.mjs";
import { DEFAULT_ABUSE_LIMITS } from "../src/abuse-protection.js";
import { createPostgresAdminDirectory } from "../src/admin-directory.js";
import { createApp } from "../src/app.js";
import { createPostgresBusinessStore } from "../src/business-store.js";
import type { AppConfig } from "../src/config.js";
import { runMigrations } from "../src/migrate.js";
import { repoRoot } from "../src/paths.js";
import { createPostgresProtection } from "../src/pg-abuse-protection.js";
import { createPostgresAdminAccounts } from "../src/admin-accounts.js";
import { createPostgresIpBans } from "../src/pg-ip-ban.js";

describe("Postgres 站长封禁与问答", () => {
  const pool = new Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const bans = () => createPostgresIpBans(pool);
  const directory = () => createPostgresAdminDirectory(pool);
  const protection = () => createPostgresProtection(pool, { rateWindowMs: 60_000, rateMax: 100, limits: DEFAULT_ABUSE_LIMITS });

  beforeAll(async () => { await runMigrations(testDatabaseUrl()); });
  beforeEach(async () => {
    await pool.query(`TRUNCATE admin_sessions, admin_accounts, ip_bans, feedback, messages, sessions, email_auth_sessions, email_login_codes,
      visitors, users, ip_chat_windows, active_chat_leases, chat_daily_usage, request_rate_windows CASCADE`);
  });
  afterAll(async () => { await pool.end(); });

  it("封禁只按摘要匹配，映射地址与 IPv4 相同，非法地址拒绝写入", async () => {
    const store = bans();
    const created = await store.ban("::ffff:203.0.113.10", "手动");
    expect(created.ip).toBe("203.0.113.10");
    expect(created.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.isBanned("203.0.113.10")).toBe(true);
    expect(await store.isBanned("203.0.113.11")).toBe(false);
    expect(await store.isBanned("unknown")).toBe(false);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const raw = await pool.query("SELECT ip_display FROM ip_bans");
    expect(raw.rows[0].ip_display).toBe("203.0.113.10");
    expect(await store.unban("203.0.113.10")).toBe(true);
    expect(await store.isBanned("::ffff:203.0.113.10")).toBe(false);
    await expect(store.ban("not-an-ip", "")).rejects.toThrow(/有效/);
  });

  it("封禁拦截该 IP 的公开接口，解除后清掉已耗尽时段并可以再聊", async () => {
    const guard = protection();
    const visitorId = randomUUID();
    await pool.query("INSERT INTO visitors (id) VALUES ($1)", [visitorId]);
    const business = createPostgresBusinessStore(pool);
    const config: AppConfig = {
      port: 0, databaseUrl: testDatabaseUrl(), cookieSecure: false, trustProxy: true,
      embeddingBaseUrl: "http://127.0.0.1:9", embeddingModel: "test", embeddingApiKey: "", embeddingDimension: 1024,
      resumeDir: join(repoRoot, "data/resume"), publicDir: join(repoRoot, "data/public"), frontendDist: join(repoRoot, "missing-dist"),
      rateLimitWindowMs: 60_000, rateLimitMax: 100, chatMock: true, mockDelayMs: 0, modelTimeoutMs: 5000, corsOrigins: [],
      abuseLimits: DEFAULT_ABUSE_LIMITS,
    };
    const http = createServer(createApp(config, {
      business,
      ipBans: bans(),
      adminAccounts: createPostgresAdminAccounts(pool),
      protection: guard,
      auth: {
        configured: true,
        authenticate: async () => ({ email: "verified@example.com", visitorId }),
        sendCode: vi.fn(async () => {}),
        verify: async () => { throw new Error("夹具不校验验证码"); },
        logout: async () => {},
      },
      vector: { upsert: vi.fn(), rebuild: vi.fn(), delete: vi.fn(), search: vi.fn(async () => []) },
    }));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    const url = `http://127.0.0.1:${address.port}`;
    const ip = "203.0.113.40";
    const chat = () => fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ message: "介绍一下" }),
    });
    try {
      expect(await (await chat()).text()).toContain("event: done");
      await pool.query("UPDATE ip_chat_windows SET expires_at = clock_timestamp() - interval '1 second'");
      const exhausted = await chat();
      expect(exhausted.status).toBe(429);
      expect(await exhausted.json()).toMatchObject({ code: "ip_time_exhausted" });
      expect(await createPostgresAdminAccounts(pool).sync("13800138000", "correct-horse")).toBe("created");
      const login = await fetch(`${url}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "13800138000", password: "correct-horse" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie().find((item) => item.startsWith("resume_admin_session="))?.split(";")[0];
      if (!cookie) throw new Error("没有站长会话");
      const ban = await fetch(`${url}/api/admin/ips/ban`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ip }),
      });
      expect(ban.status).toBe(200);
      const blocked = await chat();
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: "ip_banned" });
      expect((await fetch(`${url}/api/health`, { headers: { "X-Forwarded-For": ip } })).status).toBe(200);
      const unban = await fetch(`${url}/api/admin/ips/unban`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ip: `::ffff:${ip}` }),
      });
      expect(await unban.json()).toMatchObject({ ok: true, removedBan: true, resetWindow: true });
      expect((await pool.query("SELECT 1 FROM ip_bans")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM ip_chat_windows")).rowCount).toBe(0);
      expect(await (await chat()).text()).toContain("event: done");
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("按用户列出登录账号，并只返回可见问答", async () => {
    const userId = randomUUID();
    const visitorId = randomUUID();
    const sessionId = randomUUID();
    const email = `person-${userId.slice(0, 8)}@example.com`;
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, email]);
    await pool.query("INSERT INTO visitors (id, user_id) VALUES ($1, $2)", [visitorId, userId]);
    await pool.query("INSERT INTO sessions (id, visitor_id, title) VALUES ($1, $2, $3)", [sessionId, visitorId, "项目经历"]);
    const messages: Array<[number, unknown]> = [
      [0, { role: "user", content: "做过什么？", timestamp: 1 }],
      [1, { role: "toolResult", toolCallId: "call", toolName: "search_resume", content: [{ type: "text", text: "SECRET_CHUNK 工具原文" }], isError: false, timestamp: 2 }],
      [2, {
        role: "assistant", content: [{ type: "text", text: "<think>内部计划</think>做过电商助手。" }],
        api: "openai-completions", provider: "deepseek", model: "deepseek-flash", stopReason: "stop", timestamp: 3,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }],
    ];
    for (const [seq, message] of messages) {
      await pool.query(
        `INSERT INTO messages (id, session_id, seq, format_version, agent_message) VALUES ($1, $2, $3, 'test', $4::jsonb)`,
        [randomUUID(), sessionId, seq, JSON.stringify(message)],
      );
    }
    const users = await directory().listUsers({ limit: 20, offset: 0 });
    expect(users.total).toBe(1);
    expect(users.users[0]).toMatchObject({ userId, email, visitorCount: 1, sessionCount: 1 });
    const sessions = await directory().listSessions({ userId, visitorId: null, limit: 20, offset: 0 });
    expect(sessions.sessions.map((item) => item.id)).toEqual([sessionId]);
    expect(sessions.sessions[0]?.email).toBe(email);
    expect(sessions.sessions[0]?.ip).toBeNull();
    const detail = await directory().getSession(sessionId);
    expect(detail?.ip).toBeNull();
    expect(detail?.turns).toEqual([{ question: "做过什么？", answer: "做过电商助手。" }]);
    expect(JSON.stringify(detail?.turns)).not.toContain("SECRET_CHUNK");
    expect(JSON.stringify(detail?.turns)).not.toContain("内部计划");
    const others = await directory().listSessions({ userId: randomUUID(), visitorId: null, limit: 20, offset: 0 });
    expect(others.total).toBe(0);
  });

  it("新会话记下规范化后的客户端 IP，列表和详情能读到，旧会话仍是空", async () => {
    const visitorId = randomUUID();
    await pool.query("INSERT INTO visitors (id) VALUES ($1)", [visitorId]);
    const business = createPostgresBusinessStore(pool);
    const created = await business.createSession(visitorId, "::ffff:203.0.113.8");
    const stored = await pool.query<{ client_ip: string | null }>("SELECT client_ip FROM sessions WHERE id = $1", [created.id]);
    expect(stored.rows[0]?.client_ip).toBe("203.0.113.8");
    await pool.query(
      `INSERT INTO messages (id, session_id, seq, format_version, agent_message) VALUES ($1, $2, 0, 'test', $3::jsonb)`,
      [randomUUID(), created.id, JSON.stringify({ role: "user", content: "你好", timestamp: 1 })],
    );
    const listed = await directory().listSessions({ userId: null, visitorId, limit: 20, offset: 0 });
    expect(listed.sessions.map((item) => item.ip)).toEqual(["203.0.113.8"]);
    expect((await directory().getSession(created.id))?.ip).toBe("203.0.113.8");

    const blank = await business.createSession(visitorId, "not-an-ip");
    expect((await directory().getSession(blank.id))?.ip).toBeNull();
    const legacyId = randomUUID();
    await pool.query("INSERT INTO sessions (id, visitor_id, title) VALUES ($1, $2, '旧会话')", [legacyId, visitorId]);
    expect((await directory().getSession(legacyId))?.ip).toBeNull();
  });
});
