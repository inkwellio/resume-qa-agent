import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./verified-app.js";
import type { BusinessStore, LoadedSession } from "../src/business-store.js";
import type { AppConfig } from "../src/config.js";
import { createMemoryProtection, DEFAULT_ABUSE_LIMITS, ProtectionError } from "../src/abuse-protection.js";
import { rowsFromAgentMessages } from "../src/transcript.js";

function fixture(configOverrides: Partial<AppConfig> = {}, depsOverrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "resume-agent-app-"));
  const profile = { name: "测试候选人", headline: "开发工程师" };
  const writeProfile = () => writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
  writeProfile();
  const session: LoadedSession = { id: randomUUID(), title: "", rows: [] };
  const business: BusinessStore = {
    ensureVisitor: vi.fn(async () => randomUUID()),
    createSession: vi.fn(async () => ({ ...session, id: randomUUID(), createdAt: "", updatedAt: "" })),
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
  const config: AppConfig = {
    port: 0, databaseUrl: "unused", cookieSecure: false,
    embeddingBaseUrl: "http://127.0.0.1:9", embeddingModel: "test", embeddingApiKey: "", embeddingDimension: 1024,
    resumeDir: dir, publicDir: dir, frontendDist: join(dir, "missing"),
    rateLimitWindowMs: 60000, rateLimitMax: 20, chatMock: true, mockDelayMs: 0,
    modelTimeoutMs: 5000, trustProxy: false, corsOrigins: [],
    ...configOverrides,
  };
  const deps: AppDeps = {
    business,
    vector: { upsert: vi.fn(), rebuild: vi.fn(), delete: vi.fn(), search: vi.fn(async () => []) },
    ...depsOverrides,
  };
  const server = createServer(createApp(config, deps));
  return {
    dir, profile, writeProfile, session, business, config, deps,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("没有监听端口");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
      expect(basename(dir)).toMatch(/^resume-agent-app-/);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("HTTP 边界", () => {
  it("健康检查不访问访客库、不签发 cookie，即使访客库不可用仍可探活", async () => {
    const f = fixture();
    vi.mocked(f.business.ensureVisitor).mockRejectedValue(new Error("数据库不可用"));
    const url = await f.start();
    try {
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`${url}/api/health`);
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.json()).toMatchObject({ ok: true });
      }
      expect(f.business.ensureVisitor).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("损坏的 cookie 被当作新访客处理，不触发 URI 解码异常", async () => {
    const f = fixture();
    const url = await f.start();
    try {
      const response = await fetch(`${url}/api/sessions`, { headers: { Cookie: "resume_visitor=%E0%A4%A" } });
      expect(response.status).toBe(200);
      expect(f.business.ensureVisitor).toHaveBeenCalledWith(null);
    } finally { await f.close(); }
  });

  it("档案读取失败会结束 SSE、清理会话状态，修复文件后同一会话可重试", async () => {
    const f = fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(f.dir, "profile.json"), "not json");
    const url = await f.start();
    const body = JSON.stringify({ message: "介绍一下", sessionId: f.session.id });
    const request = () => fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    try {
      const failed = await request();
      expect(failed.status).toBe(200);
      expect(await failed.text()).toContain("event: error");
      const stop = await fetch(`${url}/api/chat/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: f.session.id }),
      });
      expect(stop.status).toBe(404);
      f.writeProfile();
      const retried = await request();
      expect(retried.status).toBe(200);
      expect(await retried.text()).toContain("event: done");
      expect(f.business.saveTranscript).toHaveBeenCalledOnce();
    } finally { logged.mockRestore(); await f.close(); }
  });
});

describe("HTTP 防刷与生成名额", () => {
  const options = (overrides = {}) => ({
    rateWindowMs: 60000, rateMax: 20,
    limits: { ...DEFAULT_ABUSE_LIMITS, heartbeatMs: 10, leaseMs: 1000, ...overrides },
  });
  const post = (url: string, body: unknown, cookie = "") => fetch(`${url}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });

  it("IP 时段到期会中止在途回答，换已验证身份和重试均被拒绝，历史及停止仍可用", async () => {
    const settings = options({ ipChatWindowMs: 150 });
    const protection = createMemoryProtection(settings);
    const f = fixture({ mockDelayMs: 500, abuseLimits: settings.limits }, { protection });
    const url = await f.start();
    try {
      const first = await post(url, { message: "介绍一下" });
      expect(first.status).toBe(200);
      const text = await first.text();
      expect(text).toContain("聊天时段已结束");
      expect(text).toContain('"stopReason":"error"');
      const denied = await post(url, { message: "换邮箱再问", verified: true }, "resume_visitor=other-verified-user");
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "ip_time_exhausted" });
      expect(denied.headers.get("retry-after")).toBeNull();
      const spoofed = await fetch(`${url}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.99" },
        body: JSON.stringify({ message: "换 IP 请求头" }),
      });
      expect(spoofed.status).toBe(429);
      expect(await spoofed.json()).toMatchObject({ code: "ip_time_exhausted" });
      expect((await post(url, { sessionId: f.session.id, retry: true })).status).toBe(429);
      expect((await fetch(`${url}/api/sessions`)).status).toBe(200);
      expect((await fetch(`${url}/api/chat/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: f.session.id }) })).status).toBe(404);
    } finally { await f.close(); }
  });

  it("防刷存储故障时拒绝请求，不创建访客或调用模型，探活仍可使用", async () => {
    const protection = createMemoryProtection(options());
    protection.rate = vi.fn(async () => { throw new Error("store unavailable sk-SECRET"); });
    const streamFn = vi.fn();
    const f = fixture({}, { protection, streamFn });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await f.start();
    try {
      const denied = await post(url, { message: "介绍一下" });
      expect(denied.status).toBe(503);
      expect(await denied.text()).not.toContain("sk-SECRET");
      expect(f.business.ensureVisitor).not.toHaveBeenCalled();
      expect(streamFn).not.toHaveBeenCalled();
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    } finally { logged.mockRestore(); await f.close(); }
  });

  it("IP 超限在创建访客前返回 429 和 Retry-After", async () => {
    const protection = createMemoryProtection(options());
    protection.rate = vi.fn(async (scope) => {
      if (scope === "chat-ip") throw new ProtectionError(429, "rate_limited", "请稍后重试", 7);
    });
    const f = fixture({}, { protection });
    const url = await f.start();
    try {
      const response = await post(url, { message: "介绍一下" });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("7");
      expect(f.business.ensureVisitor).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("每日额度用完时不再启动生成，新建的空会话被清理", async () => {
    const protection = createMemoryProtection(options({ dailyRequests: 1 }));
    const f = fixture({}, { protection });
    const url = await f.start();
    try {
      const first = await post(url, { message: "介绍一下" });
      expect(await first.text()).toContain("event: done");
      const denied = await post(url, { message: "换一个会话继续" });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "daily_quota" });
      expect(f.business.saveTranscript).toHaveBeenCalledOnce();
      expect(f.business.deleteSession).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("整轮超时保存为可重试错误，并释放并发名额", async () => {
    const settings = options({ turnTimeoutMs: 40 });
    const protection = createMemoryProtection(settings);
    const release = vi.spyOn(protection, "release");
    const f = fixture({ mockDelayMs: 500, abuseLimits: settings.limits }, { protection });
    const url = await f.start();
    try {
      const response = await post(url, { message: "介绍一下" });
      const text = await response.text();
      expect(text).toContain("本轮回答超时");
      expect(text).toContain('"stopReason":"error"');
      expect(text).not.toContain('"stopReason":"aborted"');
      expect(release).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("续租失败时中止生成并结束响应，不继续占用名额", async () => {
    const settings = options();
    const protection = createMemoryProtection(settings);
    const renew = protection.renew.bind(protection);
    let renewals = 0;
    protection.renew = vi.fn(async (permit) => {
      renewals += 1;
      if (renewals === 1) return renew(permit);
      throw new Error("store unavailable");
    });
    const release = vi.spyOn(protection, "release");
    const f = fixture({ mockDelayMs: 500, abuseLimits: settings.limits }, { protection });
    const url = await f.start();
    try {
      const response = await post(url, { message: "介绍一下" });
      expect(await response.text()).toContain("服务状态发生变化");
      expect(release).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("准入后重读会话，避免把等待期间完成的新消息覆盖掉", async () => {
    const f = fixture();
    const newer = rowsFromAgentMessages([{ role: "user", content: "等待准入期间刚保存的问题", timestamp: 0 }], new Map());
    vi.mocked(f.business.loadSession)
      .mockResolvedValueOnce({ ...f.session, rows: [] })
      .mockResolvedValueOnce({ ...f.session, rows: newer });
    const url = await f.start();
    try {
      const response = await post(url, { message: "继续提问", sessionId: f.session.id });
      expect(await response.text()).toContain("event: done");
      expect(f.business.loadSession).toHaveBeenCalledTimes(2);
      const saved = vi.mocked(f.business.saveTranscript).mock.calls[0]?.[0];
      expect(saved?.rows.some((row) => row.agentMessage.role === "user" && row.agentMessage.content === "等待准入期间刚保存的问题")).toBe(true);
    } finally { await f.close(); }
  });

  it("普通 API 用完仍可通过另一实例停止，但不能停止别人的生成", async () => {
    const settings = options({ apiRateMax: 2 });
    const protection = createMemoryProtection(settings);
    const a = fixture({ mockDelayMs: 500, abuseLimits: settings.limits }, { protection });
    const b = fixture({ abuseLimits: settings.limits }, { protection });
    vi.mocked(a.business.ensureVisitor).mockResolvedValue("owner");
    vi.mocked(b.business.ensureVisitor).mockImplementation(async (id) => id === "stranger" ? "stranger" : "owner");
    const [urlA, urlB] = await Promise.all([a.start(), b.start()]);
    try {
      const response = await post(urlA, { message: "介绍一下", sessionId: a.session.id });
      const stream = response.text();
      expect((await fetch(`${urlB}/api/sessions`)).status).toBe(200);
      expect((await fetch(`${urlB}/api/sessions`)).status).toBe(429);
      const stop = (stranger = false) => fetch(`${urlB}/api/chat/stop`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(stranger ? { Cookie: "resume_visitor=stranger" } : {}) },
        body: JSON.stringify({ sessionId: a.session.id }),
      });
      expect((await stop(true)).status).toBe(404);
      expect((await stop()).status).toBe(200);
      expect(await stream).toContain('"stopReason":"aborted"');
    } finally { await Promise.all([a.close(), b.close()]); }
  });

  it("浏览器断开后释放名额且不保存未完成的新会话", async () => {
    const protection = createMemoryProtection(options());
    let released: (() => void) | undefined;
    const done = new Promise<void>((resolve) => { released = resolve; });
    const original = protection.release.bind(protection);
    protection.release = async (permit) => { await original(permit); released?.(); };
    const f = fixture({ mockDelayMs: 500 }, { protection });
    const url = await f.start();
    const controller = new AbortController();
    try {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "介绍一下" }), signal: controller.signal,
      });
      const closed = response.text().catch(() => "aborted");
      controller.abort();
      await done;
      await closed;
      expect(f.business.saveTranscript).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

/** 使用真实 Agent 工具调度和挂起的本地向量服务，验证停止能贯通整条链路。 */
describe("检索期间停止", () => {
  it("中止向量 HTTP 请求后停止接口及时返回，且不再降级查询数据库", async () => {
    const f = fixture();
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const embeddingServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"data":');
      requestStarted?.();
    });
    await new Promise<void>((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    const address = embeddingServer.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    const app = createApp({ ...f.config, chatMock: false, embeddingBaseUrl: `http://127.0.0.1:${address.port}`, embeddingApiKey: "test" }, {
      ...f.deps,
      streamFn(model, _context, options) {
        const stream = new AssistantMessageEventStream();
        const aborted = options?.signal?.aborted;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: aborted ? [] : [{ type: "toolCall", id: "search-1", name: "search_resume", arguments: { query: "React" } }],
          stopReason: aborted ? "aborted" : "toolUse",
          usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
        };
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "toolUse", message });
        return stream;
      },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const httpAddress = server.address();
    if (!httpAddress || typeof httpAddress === "string") throw new Error("没有监听端口");
    const url = `http://127.0.0.1:${httpAddress.port}`;
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // 两次请求使用相同的访客身份。
    vi.mocked(f.business.ensureVisitor).mockResolvedValue("test-visitor");
    await f.start();
    try {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "React", sessionId: f.session.id }),
      });
      const output = response.text();
      await started;
      const stopped = await fetch(`${url}/api/chat/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: f.session.id }), signal: AbortSignal.timeout(2000),
      });
      expect(stopped.status).toBe(200);
      expect(await output).toContain('"stopReason":"aborted"');
      expect(f.deps.vector.search).not.toHaveBeenCalled();
      expect(f.business.saveTranscript).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      embeddingServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => embeddingServer.close(() => resolve())),
        f.close(),
      ]);
    }
  });
});
