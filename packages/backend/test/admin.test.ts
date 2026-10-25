import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryProtection, DEFAULT_ABUSE_LIMITS, type AbuseLimits } from "../src/abuse-protection.js";
import { createMemoryAdminAccounts, type AdminAccountStore } from "../src/admin-accounts.js";
import type { AdminDirectory } from "../src/admin-directory.js";
import { createApp, type AppDeps } from "../src/app.js";
import type { BusinessStore, LoadedSession } from "../src/business-store.js";
import type { AppConfig } from "../src/config.js";
import { createMemoryIpBans } from "../src/ip-ban.js";
import { AGENT_FORMAT_VERSION, visibleTurns, type StoredRow } from "../src/transcript.js";

const OWNER = { phone: "13800138000", password: "correct-horse" };

async function ownerCookie(url: string, accounts: AdminAccountStore): Promise<string> {
  await accounts.sync(OWNER.phone, OWNER.password);
  const response = await fetch(`${url}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  expect(response.status).toBe(200);
  const header = response.headers.getSetCookie().find((item) => item.startsWith("resume_admin_session="));
  expect(header).toMatch(/HttpOnly/);
  const cookie = header?.split(";")[0];
  if (!cookie) throw new Error("没有站长会话");
  return cookie;
}

function limits(overrides: Partial<AbuseLimits> = {}): AbuseLimits {
  return {
    ...DEFAULT_ABUSE_LIMITS,
    apiRateMax: 1000,
    visitorRateMax: 1000,
    dailyRequests: 100,
    dailyRequestsPerIp: 100,
    dailyRequestsPerVisitor: 100,
    heartbeatMs: 60_000,
    turnTimeoutMs: 5_000,
    ...overrides,
  };
}

function fixture(configOverrides: Partial<AppConfig> = {}, depsOverrides: Partial<AppDeps> = {}, now = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), "resume-agent-admin-"));
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ name: "测试候选人", headline: "开发工程师" }));
  const session: LoadedSession = { id: crypto.randomUUID(), title: "", rows: [] };
  const business: BusinessStore = {
    ensureVisitor: vi.fn(async () => crypto.randomUUID()),
    createSession: vi.fn(async () => ({ id: crypto.randomUUID(), title: "", createdAt: "", updatedAt: "" })),
    loadSession: vi.fn(async () => session),
    saveTranscript: vi.fn(async ({ rows }) => { session.rows = rows; }),
    deleteSession: vi.fn(async () => true),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    renameSession: vi.fn(async () => null),
    clearFeedback: vi.fn(),
    insertFeedback: vi.fn(),
    recentDislikes: vi.fn(async () => []),
  };
  const sendCode = vi.fn(async () => {});
  const authenticate = vi.fn(async () => ({ email: "verified@example.com", visitorId: "visitor-1" }));
  const abuse = configOverrides.abuseLimits ?? limits();
  const adminAccounts = depsOverrides.adminAccounts ?? createMemoryAdminAccounts();
  const config: AppConfig = {
    port: 0, databaseUrl: "unused", cookieSecure: false,
    embeddingBaseUrl: "http://127.0.0.1:9", embeddingModel: "test", embeddingApiKey: "", embeddingDimension: 1024,
    resumeDir: dir, publicDir: dir, frontendDist: join(dir, "missing"),
    rateLimitWindowMs: 60_000, rateLimitMax: 1000, chatMock: true, mockDelayMs: 0,
    modelTimeoutMs: 5000, trustProxy: false, corsOrigins: [], abuseLimits: abuse,
    ...configOverrides,
  };
  const protection = depsOverrides.protection ?? createMemoryProtection({
    rateWindowMs: config.rateLimitWindowMs, rateMax: config.rateLimitMax, limits: abuse,
  }, now);
  const deps: AppDeps = {
    business,
    vector: { upsert: vi.fn(), rebuild: vi.fn(), delete: vi.fn(), search: vi.fn(async () => []) },
    protection,
    auth: { configured: true, authenticate, sendCode, verify: async () => { throw new Error("夹具不校验验证码"); }, logout: async () => {} },
    adminAccounts,
    ...depsOverrides,
    adminAccounts,
  };
  let server;
  try {
    server = createServer(createApp(config, deps));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    business, authenticate, sendCode, protection, deps, adminAccounts,
    async start() {
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("没有监听端口");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
      expect(basename(dir)).toMatch(/^resume-agent-admin-/);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const authed = (cookie: string) => ({ Cookie: cookie, "Content-Type": "application/json" });

describe("可见问答", () => {
  it("只保留问题和助手可见正文，去掉思考标签和工具原文", () => {
    const rows: StoredRow[] = [
      { id: "u", seq: 0, formatVersion: AGENT_FORMAT_VERSION, uiDetails: null, agentMessage: { role: "user", content: "做过什么？", timestamp: 1 } },
      {
        id: "t", seq: 1, formatVersion: AGENT_FORMAT_VERSION,
        uiDetails: { toolCallId: "call", toolName: "search_resume", label: "检索", isError: false, details: { kind: "search", items: [{ id: "chunk-1" }] } },
        agentMessage: { role: "toolResult", toolCallId: "call", toolName: "search_resume", content: [{ type: "text", text: "SECRET_CHUNK 工具原文" }], isError: false, timestamp: 2 },
      },
      {
        id: "a", seq: 2, formatVersion: AGENT_FORMAT_VERSION, uiDetails: null,
        agentMessage: {
          role: "assistant",
          content: [{ type: "text", text: "<think>内部计划</think>做过电商助手。" }],
          api: "openai-completions", provider: "deepseek", model: "deepseek-flash",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: 3,
        } satisfies AgentMessage,
      },
    ];
    expect(visibleTurns(rows)).toEqual([{ question: "做过什么？", answer: "做过电商助手。" }]);
  });
});

describe("站长鉴权", () => {
  it("网页没有注册入口，命令行同步的账号可以登录，退出后接口 401", async () => {
    const directory: AdminDirectory = {
      listUsers: vi.fn(async () => ({
        users: [{ userId: "user-1", email: "owner@example.com", createdAt: "2026-01-01T00:00:00.000Z", visitorCount: 1, sessionCount: 2, lastSessionAt: null }],
        total: 1,
      })),
      listSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
      getSession: vi.fn(async () => null),
    };
    const f = fixture({}, { adminDirectory: directory });
    const url = await f.start();
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    try {
      expect(await (await fetch(`${url}/api/admin/session`)).json()).toEqual({ authenticated: false });
      for (const path of ["/api/admin/users", "/api/admin/sessions", "/api/admin/ips"]) {
        expect((await fetch(`${url}${path}`)).status).toBe(401);
      }
      expect((await fetch(`${url}/api/admin/users`, { headers: { Authorization: "Bearer " + "a".repeat(32) } })).status).toBe(401);
      const registration = await post("/api/admin/setup", { phone: OWNER.phone, password: OWNER.password, confirmPassword: OWNER.password });
      expect(registration.status).toBe(401);
      const cookie = await ownerCookie(url, f.adminAccounts);
      expect(await (await fetch(`${url}/api/admin/session`, { headers: { Cookie: cookie } })).json()).toEqual({ authenticated: true });
      expect(await f.adminAccounts.sync(OWNER.phone, OWNER.password)).toBe("unchanged");
      const wrong = await post("/api/admin/login", { phone: "13900139000", password: "correct-horse" });
      const badPassword = await post("/api/admin/login", { phone: OWNER.phone, password: "wrong-horse" });
      expect(wrong.status).toBe(401);
      expect(badPassword.status).toBe(401);
      const wrongBody = await wrong.json();
      expect(wrongBody).toEqual(await badPassword.json());
      expect(wrongBody).toMatchObject({ message: "手机号或密码错误" });
      const users = await fetch(`${url}/api/admin/users`, { headers: { Cookie: cookie } });
      expect(users.status).toBe(200);
      expect(await users.json()).toMatchObject({ users: [{ email: "owner@example.com" }], total: 1 });
      expect((await fetch(`${url}/api/admin/users`, { headers: { Authorization: "Bearer nope", Cookie: cookie } })).status).toBe(200);
      expect((await fetch(`${url}/api/admin/users`, { headers: { Cookie: "resume_admin=" + "a".repeat(32) } })).status).toBe(401);
      expect((await fetch(`${url}/api/admin/missing`, { headers: { Cookie: cookie } })).status).toBe(404);
      expect((await fetch(`${url}/api/admin/sessions?userId=not-a-uuid`, { headers: { Cookie: cookie } })).status).toBe(400);
      const loggedOut = await post("/api/admin/logout", {}, cookie);
      expect(loggedOut.status).toBe(200);
      expect((await fetch(`${url}/api/admin/users`, { headers: { Cookie: cookie } })).status).toBe(401);
      expect(f.business.ensureVisitor).not.toHaveBeenCalled();
      expect(directory.listSessions).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("生产环境必须注入黑名单、站长账号和查询存储", () => {
    vi.stubEnv("NODE_ENV", "production");
    const protection = createMemoryProtection({ rateWindowMs: 1000, rateMax: 10, limits: limits() });
    try {
      expect(() => fixture({}, { protection })).toThrow(/黑名单/);
      expect(() => fixture({}, { protection, ipBans: createMemoryIpBans() })).toThrow(/站长账号/);
      expect(() => fixture({}, {
        protection,
        ipBans: createMemoryIpBans(),
        adminAccounts: { sync: async () => "unchanged" as const, findByPhone: async () => null, createSession: async () => ({ token: "ab" }), authenticate: async () => null, revoke: async () => {} },
      })).toThrow(/站长查询/);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("会话客户端 IP", () => {
  it("列表和详情原样返回记下的明文，没有则是 null", async () => {
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "项目经历",
      visitorId: "22222222-2222-4222-8222-222222222222",
      userId: null,
      email: "a@example.com",
      ip: "203.0.113.10",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      turns: [{ question: "做过什么？", answer: "做过电商助手。" }],
    };
    const missing = { ...session, id: "33333333-3333-4333-8333-333333333333", ip: null, turns: [] as Array<{ question: string; answer: string }> };
    const directory: AdminDirectory = {
      listUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listSessions: vi.fn(async () => ({ sessions: [session, missing], total: 2 })),
      getSession: vi.fn(async (id: string) => (id === missing.id ? missing : session)),
    };
    const f = fixture({}, { adminDirectory: directory });
    const url = await f.start();
    try {
      const cookie = await ownerCookie(url, f.adminAccounts);
      const listed = await fetch(`${url}/api/admin/sessions`, { headers: { Cookie: cookie } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        sessions: [{ id: session.id, ip: "203.0.113.10" }, { id: missing.id, ip: null }],
      });
      const detail = await fetch(`${url}/api/admin/sessions/${session.id}`, { headers: { Cookie: cookie } });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ ip: "203.0.113.10", turns: session.turns });
      const empty = await fetch(`${url}/api/admin/sessions/${missing.id}`, { headers: { Cookie: cookie } });
      expect(await empty.json()).toMatchObject({ ip: null });
    } finally { await f.close(); }
  });
});

describe("永久封禁与解除", () => {
  it("按可信代理中的客户端 IP 封禁公开接口，探活和站长接口仍可用；未开代理时忽略伪造头", async () => {
    const open = fixture({ trustProxy: false });
    const openUrl = await open.start();
    try {
      const openCookie = await ownerCookie(openUrl, open.adminAccounts);
      const ban = await fetch(`${openUrl}/api/admin/ips/ban`, {
        method: "POST", headers: authed(openCookie), body: JSON.stringify({ ip: "::ffff:203.0.113.10", note: "刷接口" }),
      });
      expect(ban.status).toBe(200);
      expect(await ban.json()).toMatchObject({ ok: true, ip: "203.0.113.10", note: "刷接口" });
      const spoofed = await fetch(`${openUrl}/api/profile`, { headers: { "X-Forwarded-For": "203.0.113.10" } });
      expect(spoofed.status).toBe(200);
      const invalid = await fetch(`${openUrl}/api/admin/ips/ban`, { method: "POST", headers: authed(openCookie), body: JSON.stringify({ ip: "not-an-ip" }) });
      expect(invalid.status).toBe(400);
    } finally { await open.close(); }

    const f = fixture({ trustProxy: true });
    const url = await f.start();
    const cookie = await ownerCookie(url, f.adminAccounts);
    const forwarded = (path: string, ip: string, init: RequestInit = {}) => fetch(`${url}${path}`, {
      ...init,
      headers: { "X-Forwarded-For": ip, ...(init.headers ?? {}) },
    });
    try {
      expect((await fetch(`${url}/api/admin/ips/ban`, {
        method: "POST", headers: authed(cookie), body: JSON.stringify({ ip: "203.0.113.10" }),
      })).status).toBe(200);
      const denied = await forwarded("/api/profile", "203.0.113.10");
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "ip_banned" });
      expect(f.business.ensureVisitor).not.toHaveBeenCalled();
      expect((await forwarded("/api/chat", "203.0.113.10", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "你好" }),
      })).status).toBe(403);
      expect(f.business.createSession).not.toHaveBeenCalled();
      expect(f.authenticate).not.toHaveBeenCalled();
      const code = await forwarded("/api/auth/code", "203.0.113.10", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
      });
      expect(code.status).toBe(403);
      expect(f.sendCode).not.toHaveBeenCalled();
      expect((await forwarded("/api/profile", "198.51.100.20")).status).toBe(200);
      expect((await forwarded("/api/health", "203.0.113.10")).status).toBe(200);
      const admin = await forwarded("/api/admin/ips", "203.0.113.10", { headers: { Cookie: cookie } });
      expect(admin.status).toBe(200);
      const listed = await admin.json() as { bans: Array<{ ip: string; window: unknown }> };
      expect(listed.bans.map((item) => item.ip)).toContain("203.0.113.10");
    } finally { await f.close(); }
  });

  it("解除禁止后已耗尽的 15 分钟时段被清掉，同一 IP 可以重新提问", async () => {
    let now = 1_000;
    const abuse = limits({ ipChatWindowMs: 1_000 });
    const protection = createMemoryProtection({ rateWindowMs: 60_000, rateMax: 1000, limits: abuse }, () => now);
    const f = fixture({ trustProxy: true, abuseLimits: abuse }, { protection });
    const url = await f.start();
    const cookie = await ownerCookie(url, f.adminAccounts);
    const ip = "203.0.113.77";
    const chat = () => fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ message: "介绍一下" }),
    });
    try {
      expect(await (await chat()).text()).toContain("event: done");
      now = 2_000;
      const exhausted = await chat();
      expect(exhausted.status).toBe(429);
      expect(await exhausted.json()).toMatchObject({ code: "ip_time_exhausted" });
      const unban = await fetch(`${url}/api/admin/ips/unban`, {
        method: "POST", headers: authed(cookie), body: JSON.stringify({ ip: `::ffff:${ip}` }),
      });
      expect(unban.status).toBe(200);
      expect(await unban.json()).toMatchObject({ ok: true, removedBan: false, resetWindow: true });
      expect(await (await chat()).text()).toContain("event: done");
      const windows = await fetch(`${url}/api/admin/ips`, { headers: { Cookie: cookie } });
      const body = await windows.json() as { windows: Array<{ exhausted: boolean }> };
      expect(body.windows.some((item) => item.exhausted)).toBe(false);
    } finally { await f.close(); }
  });
});

afterEach(() => { vi.unstubAllEnvs(); });
