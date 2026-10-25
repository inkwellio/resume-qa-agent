import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl } from "../../../scripts/test-database.mjs";
import { createApp } from "../src/app.js";
import { createPostgresBusinessStore } from "../src/business-store.js";
import { createPostgresEmailAuth, type EmailAuth, type EmailAuthConfig } from "../src/email-auth.js";
import { runMigrations } from "../src/migrate.js";
import { repoRoot } from "../src/paths.js";
import type { AppConfig } from "../src/config.js";

describe("Postgres 邮箱验证与 HTTP 访问控制", () => {
  const poolA = new Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5000 });
  const poolB = new Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5000 });
  const config: EmailAuthConfig = { secret: "test-secret".repeat(4), accessKeyId: "test", accessKeySecret: "test", securityToken: "", accountName: "login@example.com", devMailer: false, dailySendLimit: 100, dailySendLimitPerIp: 20 };
  const deliveries = new Map<string, string>();
  const send = vi.fn(async (email: string, code: string) => { deliveries.set(email, code); });
  const auth = (pool = poolA, overrides: Partial<EmailAuthConfig> = {}) => createPostgresEmailAuth(pool, { ...config, ...overrides }, { send });
  const code = (email: string) => { const result = deliveries.get(email); if (!result) throw new Error("测试邮件缺失"); return result; };
  const ageCodes = () => poolA.query("UPDATE email_login_codes SET sent_at = now() - interval '61 seconds'");
  const login = async (email: string, ip = "ip") => { const service = auth(); await service.sendCode(email, ip); return service.verify(email, code(email), ip); };
  beforeAll(async () => { await runMigrations(testDatabaseUrl()); });
  beforeEach(async () => {
    send.mockClear(); deliveries.clear();
    await poolA.query("TRUNCATE users, visitors, email_login_codes, request_rate_windows, chat_daily_usage, active_chat_leases, ip_chat_windows CASCADE");
  });
  afterAll(async () => { await Promise.all([poolA.end(), poolB.end()]); });

  it("验证码和登录凭证仅保存摘要，多实例可验证，正确验证码只能使用一次", async () => {
    const a = auth(), b = auth(poolB);
    await a.sendCode(" User@QQ.com ", "ip");
    const raw = await poolA.query("SELECT * FROM email_login_codes");
    expect(raw.rows[0]).toMatchObject({ code_hash: expect.stringMatching(/^[a-f0-9]{64}$/), ready: true });
    expect(JSON.stringify(raw.rows)).not.toContain("user@qq.com");
    const result = await b.verify("USER@qq.com", code("user@qq.com"), "ip");
    expect(await a.authenticate(result.token)).toEqual(result.identity);
    const sessions = await poolA.query("SELECT token_hash FROM email_auth_sessions");
    expect(sessions.rows[0].token_hash).not.toBe(result.token);
    await expect(a.verify("user@qq.com", code("user@qq.com"), "ip")).rejects.toMatchObject({ code: "invalid_code" });
    await expect(a.sendCode("user@qq.com", "new-ip")).rejects.toMatchObject({ code: "code_cooldown" });
  });

  it("两实例同时提交同一验证码只产生一次登录", async () => {
    await auth().sendCode("u@qq.com", "ip");
    const results = await Promise.allSettled([auth().verify("u@qq.com", code("u@qq.com"), "a"), auth(poolB).verify("u@qq.com", code("u@qq.com"), "b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await poolA.query("SELECT * FROM email_auth_sessions")).rowCount).toBe(1);
  });

  it("并发发送同邮箱只发一封，冷却、重发替换验证码跨实例生效", async () => {
    const results = await Promise.allSettled([auth().sendCode("u@qq.com", "a"), auth(poolB).sendCode("u@qq.com", "b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const old = code("u@qq.com");
    const previous = (await poolA.query("SELECT generation, code_hash FROM email_login_codes")).rows[0];
    await ageCodes();
    await auth(poolB).sendCode("u@qq.com", "c");
    const current = (await poolA.query("SELECT generation, code_hash FROM email_login_codes")).rows[0];
    expect(current.generation).not.toBe(previous.generation);
    expect(current.code_hash).not.toBe(previous.code_hash);
    // 允许极小概率随机值相同；不把概率事件变成不稳定测试。
    if (code("u@qq.com") !== old) await expect(auth().verify("u@qq.com", old, "ip")).rejects.toMatchObject({ code: "invalid_code" });
    await expect(auth().verify("u@qq.com", code("u@qq.com"), "ip")).resolves.toHaveProperty("token");
  });

  it("五次错误后正确码也失效，重建实例无法重置；过期码不能登录", async () => {
    await auth().sendCode("u@qq.com", "ip");
    const wrong = code("u@qq.com") === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) await expect(auth().verify("u@qq.com", wrong, `ip${i}`)).rejects.toMatchObject({ code: "invalid_code" });
    await expect(auth(poolB).verify("u@qq.com", code("u@qq.com"), "ip")).rejects.toMatchObject({ code: "invalid_code" });
    await auth().sendCode("other@163.com", "ip");
    await poolA.query("UPDATE email_login_codes SET expires_at = now() - interval '1 second'");
    await expect(auth().verify("other@163.com", code("other@163.com"), "ip")).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("发送失败的码不能登录，原始错误信息不回传", async () => {
    const service = createPostgresEmailAuth(poolA, config, { send: async (email, value) => { deliveries.set(email, value); throw new Error("secret-email-key"); } });
    await expect(service.sendCode("u@qq.com", "ip")).rejects.toMatchObject({ code: "email_send_failed", message: "验证码发送失败，请稍后再试。" });
    await expect(service.verify("u@qq.com", code("u@qq.com"), "ip")).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("邮件全站/IP 每日额度跨实例生效，换 cookie 不重置", async () => {
    await auth(poolA, { dailySendLimit: 1 }).sendCode("u@qq.com", "a");
    await expect(auth(poolB, { dailySendLimit: 1 }).sendCode("b@qq.com", "b")).rejects.toMatchObject({ status: 429 });
    expect(send).toHaveBeenCalledTimes(1);
    await poolA.query("TRUNCATE request_rate_windows");
    await auth(poolA, { dailySendLimitPerIp: 1 }).sendCode("c@qq.com", "same-ip");
    await expect(auth(poolB, { dailySendLimitPerIp: 1 }).sendCode("d@qq.com", "same-ip")).rejects.toMatchObject({ status: 429 });
  });

  it("登录七天到期、伪造 token 和退出后拒绝；同邮箱重登复用固定访客身份", async () => {
    const first = await login("u@qq.com");
    expect(await auth().authenticate(randomUUID())).toBeNull();
    expect(await auth().authenticate("0".repeat(64))).toBeNull();
    await auth(poolB).logout(first.token);
    expect(await auth().authenticate(first.token)).toBeNull();
    await ageCodes();
    const second = await login("u@qq.com", "other-ip");
    expect(second.identity.visitorId).toBe(first.identity.visitorId);
    expect(second.token).not.toBe(first.token);
    await poolA.query("UPDATE email_auth_sessions SET expires_at = now() - interval '1 second'");
    expect(await auth().authenticate(second.token)).toBeNull();
  });

  async function server(service: EmailAuth | null = auth()) {
    const business = createPostgresBusinessStore(poolA);
    const settings: AppConfig = {
      port: 0, databaseUrl: testDatabaseUrl(), cookieSecure: true,
      embeddingBaseUrl: "http://127.0.0.1:9", embeddingModel: "test", embeddingApiKey: "", embeddingDimension: 1024,
      resumeDir: join(repoRoot, "data/resume"), publicDir: join(repoRoot, "data/public"), frontendDist: join(repoRoot, "missing-dist"),
      rateLimitWindowMs: 60000, rateLimitMax: 100, chatMock: true, mockDelayMs: 0, modelTimeoutMs: 5000, trustProxy: false, corsOrigins: [],
    };
    const streamFn = vi.fn();
    const http = createServer(createApp(settings, { business, ...(service ? { auth: service } : {}), streamFn,
      vector: { upsert: vi.fn(), rebuild: vi.fn(), delete: vi.fn(), search: vi.fn(async () => []) },
    }));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("端口缺失");
    const url = `http://127.0.0.1:${address.port}`;
    return { url, streamFn, business, close: async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); } };
  }
  const post = (url: string, path: string, body: unknown, cookie = "", origin?: string) => fetch(`${url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
  const cookies = (response: Response) => response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

  it("未验证、仅伪造访客 cookie、伪造登录 cookie 都不能聊天/重生成/重试/访问历史或反馈，公开档案可读", async () => {
    const f = await server();
    try {
      const visitor = await f.business.ensureVisitor(null);
      for (const cookie of ["", `resume_visitor=${visitor}`, `resume_auth=${"a".repeat(64)}`]) {
        for (const body of [{ message: "介绍一下" }, { retry: true }, { regenerate: true }]) {
          const response = await post(f.url, "/api/chat", body, cookie);
          expect(response.status).toBe(401);
          expect(response.headers.get("Content-Type")).toContain("application/json");
        }
        expect((await fetch(`${f.url}/api/sessions`, { headers: { Cookie: cookie } })).status).toBe(401);
        expect((await post(f.url, "/api/feedback", {}, cookie)).status).toBe(401);
        expect((await post(f.url, "/api/chat/stop", {}, cookie)).status).toBe(401);
      }
      expect(f.streamFn).not.toHaveBeenCalled();
      expect((await post(f.url, "/API/CHAT/", { message: "hi" })).status).toBe(401);
      expect((await poolA.query("SELECT * FROM sessions")).rowCount).toBe(0);
      expect((await fetch(`${f.url}/api/profile`)).status).toBe(200);
      expect((await fetch(`${f.url}/api/health`)).status).toBe(200);
    } finally { await f.close(); }
  });

  it("真实 HTTP 获取验证码→验证→cookie 聊天→退出闭环；不接受前端自报 verified/email", async () => {
    const f = await server();
    try {
      expect((await post(f.url, "/api/chat", { message: "hi", verified: true, email: "u@qq.com" })).status).toBe(401);
      const sent = await post(f.url, "/api/auth/code", { email: "u@qq.com" });
      expect(await sent.json()).toEqual({ ok: true, expiresIn: 300, retryAfter: 60 });
      const verified = await post(f.url, "/api/auth/verify", { email: "u@qq.com", code: code("u@qq.com") });
      expect(verified.status).toBe(200);
      expect(verified.headers.get("set-cookie")).toContain("HttpOnly");
      expect(verified.headers.get("set-cookie")).toContain("Secure");
      expect(await verified.json()).toEqual({ authenticated: true, email: "u@qq.com" });
      const cookie = cookies(verified);
      const state = await fetch(`${f.url}/api/auth/session`, { headers: { Cookie: cookie } });
      expect(await state.json()).toMatchObject({ authenticated: true, email: "u@qq.com" });
      expect(state.headers.get("cache-control")).toBe("no-store");
      const chat = await post(f.url, "/api/chat", { message: "你好" }, cookie);
      expect(chat.status).toBe(200);
      expect(await chat.text()).toContain("event: done");
      expect((await post(f.url, "/api/auth/logout", {}, cookie)).status).toBe(200);
      expect((await post(f.url, "/api/chat", { message: "你好" }, cookie)).status).toBe(401);
    } finally { await f.close(); }
  });

  it("其他邮箱不能读取或修改历史，伪造 visitor cookie 不能切换身份", async () => {
    const a = await login("a@qq.com", "a"), b = await login("b@qq.com", "b");
    const business = createPostgresBusinessStore(poolA);
    const session = await business.createSession(a.identity.visitorId);
    const f = await server();
    try {
      const cookie = `resume_auth=${b.token}; resume_visitor=${a.identity.visitorId}`;
      expect((await fetch(`${f.url}/api/sessions/${session.id}`, { headers: { Cookie: cookie } })).status).toBe(404);
      expect((await fetch(`${f.url}/api/sessions/${session.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(404);
      expect((await business.loadSession(a.identity.visitorId, session.id))?.id).toBe(session.id);
    } finally { await f.close(); }
  });

  it("不可信来源不能触发验证码或登录；未配置邮件服务不开放聊天", async () => {
    const f = await server(auth(poolA, { secret: "" }));
    try {
      expect((await post(f.url, "/api/auth/code", { email: "u@qq.com" }, "", "https://evil.example")).status).toBe(403);
      expect((await post(f.url, "/api/auth/code", { email: "u@qq.com" })).status).toBe(503);
      expect((await fetch(`${f.url}/api/auth/logout`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" })).status).toBe(415);
      expect((await post(f.url, "/api/chat", { message: "hi" })).status).toBe(401);
      expect(send).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("没有注入认证服务或认证存储故障时，不降级开放聊天", async () => {
    const missing = await server(null);
    try {
      expect((await post(missing.url, "/api/chat", { message: "hi" })).status).toBe(401);
      expect((await post(missing.url, "/api/auth/code", { email: "u@qq.com" })).status).toBe(503);
      expect(missing.streamFn).not.toHaveBeenCalled();
    } finally { await missing.close(); }
    const service = auth();
    service.authenticate = async () => { throw new Error("secret database error"); };
    const f = await server(service);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await post(f.url, "/api/chat", { message: "hi" });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret database error");
      expect(f.streamFn).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); await f.close(); }
  });
});
