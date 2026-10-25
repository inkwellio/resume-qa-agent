import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createEmbeddingClient,
  loadProfile,
  loadResumeDirectory,
  searchResume,
  VECTOR_DIMENSION,
  type Profile,
  type VectorStore,
} from "@resume/retrieval";
import express, { type Express, type Request, type Response } from "express";
import { streamChat } from "./chat-turn.js";
import type { AppConfig } from "./config.js";
import { selectChatModel } from "./model.js";
import { createMemoryProtection, DEFAULT_ABUSE_LIMITS, IP_CHAT_WINDOW_EXPIRED_MESSAGE, normalizeClientIp, ProtectionError, type AbuseProtection, type ChatPermit } from "./abuse-protection.js";
import { mountAdminRoutes } from "./admin-routes.js";
import { createMemoryAdminAccounts, type AdminAccountStore } from "./admin-accounts.js";
import { createEmptyAdminDirectory, type AdminDirectory } from "./admin-directory.js";
import { createMemoryIpBans, type IpBanStore } from "./ip-ban.js";
import { formatSse, type SseEvent } from "./sse.js";
import { createResumeTools, toolLabelMap, type ResumeLookup } from "./tools.js";
import { FeedbackError, type BusinessStore, type LoadedSession } from "./business-store.js";
import { sanitizeErrorMessage } from "./transcript.js";
import { AUTH_COOKIE, AuthError, authCookie, CODE_TTL_SECONDS, RESEND_SECONDS, type EmailAuth, type EmailIdentity } from "./email-auth.js";

const VISITOR_COOKIE = "resume_visitor";
const DISLIKE_REASONS = ["信息不准确", "没回答到点上", "其他"] as const;

export interface AppDeps {
  business: BusinessStore;
  vector: VectorStore;
  streamFn?: StreamFn;
  protection?: AbuseProtection;
  auth?: EmailAuth;
  ipBans?: IpBanStore;
  adminAccounts?: AdminAccountStore;
  adminDirectory?: AdminDirectory;
}

function clientIp(req: Request): string {
  return normalizeClientIp(req.ip || req.socket.remoteAddress || "unknown");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function visitorCookie(id: string, secure: boolean): string {
  const parts = [
    `${VISITOR_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 400}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function writeEvent(res: Response, event: SseEvent, closed: () => boolean): void {
  if (closed() || res.writableEnded) return;
  res.write(formatSse(event));
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function visitorId(res: Response): string {
  const id = res.locals.visitorId;
  return typeof id === "string" ? id : "";
}

export function createLookup(config: AppConfig, vector: VectorStore): ResumeLookup {
  const client = createEmbeddingClient({
    baseUrl: config.embeddingBaseUrl,
    model: config.embeddingModel,
    apiKey: config.embeddingApiKey,
    ...(config.embeddingTimeoutMs !== undefined ? { timeoutMs: config.embeddingTimeoutMs } : {}),
  });
  return {
    getProfile: () => loadProfile(config.resumeDir),
    // 按 id 直接读原文，不走向量。索引没建好时「查看详情」仍然可用。
    getById: (id) => {
      const chunk = loadResumeDirectory(config.resumeDir).chunks.find((item) => item.id === id);
      return Promise.resolve(chunk ?? null);
    },
    search: async (query, signal) => {
      signal?.throwIfAborted();
      if (config.embeddingDimension !== VECTOR_DIMENSION) {
        throw new Error(
          `EMBEDDING_DIMENSION=${config.embeddingDimension}，数据库列是 vector(${VECTOR_DIMENSION})。两者必须一致。`,
        );
      }
      if (!config.embeddingApiKey) return vector.search(query, null);
      return searchResume(vector, client, query, signal);
    },
  };
}

export function createApp(config: AppConfig, deps: AppDeps): Express {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  const model = selectChatModel(config.deepseekModelId);
  const lookup = createLookup(config, deps.vector);
  // 查看详情走这份不限额的工具。聊天每轮另建一份，检索次数才不会串到别的会话。
  const tools = createResumeTools(lookup, { perTurnLimits: false });
  const limits = config.abuseLimits ?? DEFAULT_ABUSE_LIMITS;
  if (process.env.NODE_ENV === "production" && !deps.protection) throw new Error("生产环境必须配置共享的防刷存储");
  const protection = deps.protection ?? createMemoryProtection({ rateWindowMs: config.rateLimitWindowMs, rateMax: config.rateLimitMax, limits });
  if (process.env.NODE_ENV === "production" && !deps.ipBans) throw new Error("生产环境必须配置 IP 黑名单存储");
  if (process.env.NODE_ENV === "production" && !deps.adminAccounts) throw new Error("生产环境必须配置站长账号存储");
  if (process.env.NODE_ENV === "production" && !deps.adminDirectory) throw new Error("生产环境必须配置站长查询存储");
  const ipBans = deps.ipBans ?? createMemoryIpBans();
  const adminAccounts = deps.adminAccounts ?? createMemoryAdminAccounts();
  const adminDirectory = deps.adminDirectory ?? createEmptyAdminDirectory();
  const protectionFailure = (res: Response, error: unknown) => {
    if (error instanceof ProtectionError) {
      if (error.retryAfter !== null) res.setHeader("Retry-After", String(error.retryAfter));
      res.status(error.status).json({ message: error.message, code: error.code });
    } else {
      console.error("防刷存储不可用，已拒绝请求");
      res.status(503).json({ message: "服务暂时不可用，请稍后再试。", code: "protection_unavailable" });
    }
  };
  const busy = new Set<string>();
  const runs = new Map<
    string,
    { visitorId: string; stopRequested: boolean; abort: (() => void) | null; done: Promise<void>; finish: () => void }
  >();

  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && !["GET", "HEAD", "OPTIONS"].includes(req.method)
      && !config.corsOrigins.includes(origin) && origin !== `${req.protocol}://${req.get("host")}`) {
      res.status(403).json({ message: "请求来源不受信任。", code: "invalid_origin" });
      return;
    }
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // 探活不签发身份、不写数据库，避免容器健康检查不断创建访客。
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mock: config.chatMock, provider: model.provider, model: model.id });
  });

  // 封禁早于限流和访客创建。探活和站长接口除外，避免健康检查失败，也避免站长无法解封。
  app.use("/api", async (req, res, next) => {
    const path = req.path.toLowerCase();
    if (path === "/health" || path === "/admin" || path.startsWith("/admin/")) {
      next();
      return;
    }
    try {
      if (await ipBans.isBanned(clientIp(req))) {
        res.setHeader("Cache-Control", "no-store");
        res.status(403).json({ message: "该 IP 已被禁止访问。", code: "ip_banned" });
        return;
      }
      next();
    } catch {
      console.error("IP 黑名单暂时不可用");
      res.status(503).json({ message: "服务暂时不可用，请稍后再试。", code: "protection_unavailable" });
    }
  });

  app.use("/api", async (req, res, next) => {
    try {
      // 停止有独立的保留窗口，不受普通 API 配额阻挡，也不能无限创建访客。
      if (req.path.toLowerCase() === "/chat/stop") {
        await protection.rate("stop-ip", clientIp(req));
      } else {
        await protection.rate("api-ip", clientIp(req));
        if (req.path.toLowerCase() === "/chat" && req.method === "POST") await protection.rate("chat-ip", clientIp(req));
      }
    } catch (error) {
      protectionFailure(res, error);
      return;
    }
    next();
  });

  mountAdminRoutes(app, { accounts: adminAccounts, cookieSecure: config.cookieSecure, ipBans, directory: adminDirectory, protection });

  app.use("/api/auth", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ message: "请使用 JSON 提交验证请求。", code: "json_required" });
      return;
    }
    next();
  });
  const authFailure = (res: Response, error: unknown) => {
    if (error instanceof AuthError) {
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      res.status(error.status).json({ message: error.message, code: error.code });
    } else {
      console.error("邮箱验证服务暂时不可用");
      res.status(503).json({ message: "邮箱验证暂时不可用，请稍后重试。", code: "auth_unavailable" });
    }
  };
  const requireAuthService = () => {
    if (!deps.auth?.configured) throw new AuthError(503, "email_unavailable", "邮箱验证暂未开放，请稍后再试。");
    return deps.auth;
  };
  app.get("/api/auth/session", async (req, res) => {
    try {
      const identity = await deps.auth?.authenticate(readCookie(req.header("cookie"), AUTH_COOKIE));
      res.json({ authenticated: Boolean(identity), email: identity?.email ?? null, configured: Boolean(deps.auth?.configured) });
    } catch (error) { authFailure(res, error); }
  });
  app.post("/api/auth/code", async (req, res) => {
    try {
      await requireAuthService().sendCode(req.body?.email, clientIp(req));
      res.json({ ok: true, expiresIn: CODE_TTL_SECONDS, retryAfter: RESEND_SECONDS });
    } catch (error) { authFailure(res, error); }
  });
  app.post("/api/auth/verify", async (req, res) => {
    try {
      const { token, identity } = await requireAuthService().verify(req.body?.email, req.body?.code, clientIp(req));
      res.append("Set-Cookie", authCookie(token, config.cookieSecure));
      // 新登录身份的历史记录仅取自该邮箱，不承接未经验证的访客 cookie。
      res.append("Set-Cookie", visitorCookie(identity.visitorId, config.cookieSecure));
      res.json({ authenticated: true, email: identity.email });
    } catch (error) { authFailure(res, error); }
  });
  app.post("/api/auth/logout", async (req, res) => {
    try {
      await deps.auth?.logout(readCookie(req.header("cookie"), AUTH_COOKIE));
      res.append("Set-Cookie", authCookie("", config.cookieSecure, true));
      res.append("Set-Cookie", `${VISITOR_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? "; Secure" : ""}`);
      res.json({ ok: true });
    } catch (error) { authFailure(res, error); }
  });

  app.use("/api", async (req, res, next) => {
    try {
      const protectedPath = /^\/(chat|sessions|feedback)(\/|$)/i.test(req.path);
      if (protectedPath) {
        res.setHeader("Cache-Control", "no-store");
        const identity: EmailIdentity | null = await deps.auth?.authenticate(readCookie(req.header("cookie"), AUTH_COOKIE)) ?? null;
        if (!identity) {
          res.status(401).json({ message: "请先通过邮箱验证码验证后再参与聊天。", code: "email_verification_required" });
          return;
        }
        res.locals.visitorId = identity.visitorId;
        // 保持原有访客 cookie 兼容；访问权限始终由独立的登录凭证决定。
        if (readCookie(req.header("cookie"), VISITOR_COOKIE) !== identity.visitorId) res.append("Set-Cookie", visitorCookie(identity.visitorId, config.cookieSecure));
        next();
        return;
      }
      const current = readCookie(req.header("cookie"), VISITOR_COOKIE);
      const id = await deps.business.ensureVisitor(current);
      res.locals.visitorId = id;
      if (id !== current) res.append("Set-Cookie", visitorCookie(id, config.cookieSecure));
      next();
    } catch (error) {
      authFailure(res, error);
    }
  });

  app.get("/api/profile", (_req, res) => {
    try {
      res.json(loadProfile(config.resumeDir));
    } catch (error) {
      res.status(500).json({ message: error instanceof Error ? error.message : "读取档案失败" });
    }
  });

  app.get("/api/sessions", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const sessions = await deps.business.listSessions(visitorId(res), query);
    res.json({ sessions });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const session = await deps.business.getSession(visitorId(res), String(req.params.id ?? ""));
    if (!session) {
      res.status(404).json({ message: "没有找到这轮对话。" });
      return;
    }
    res.json(session);
  });

  app.patch("/api/sessions/:id", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim().replace(/\s+/g, " ") : "";
    if (!title) {
      res.status(400).json({ message: "请输入对话标题。" });
      return;
    }
    if (title.length > 80) {
      res.status(400).json({ message: "标题请控制在 80 字以内。" });
      return;
    }
    const updated = await deps.business.renameSession(visitorId(res), String(req.params.id ?? ""), title);
    if (!updated) {
      res.status(404).json({ message: "没有找到这轮对话。" });
      return;
    }
    res.json(updated);
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const removed = await deps.business.deleteSession(visitorId(res), String(req.params.id ?? ""));
    if (!removed) {
      res.status(404).json({ message: "没有找到这轮对话。" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/projects/:id", async (req, res) => {
    const id = String(req.params.id ?? "");
    const tool = tools.find((item) => item.name === "get_project_detail");
    if (!tool) {
      res.status(500).json({ message: "缺少项目工具" });
      return;
    }
    try {
      const result = await tool.execute("ui", { id });
      const details = result.details as { kind?: string } | undefined;
      if (details?.kind === "project") {
        res.json(details);
        return;
      }
      res.status(404).json({ message: toolText(result) || "简历里没有这个项目。" });
    } catch (error) {
      res.status(500).json({ message: error instanceof Error ? error.message : "读取项目失败" });
    }
  });

  app.post("/api/feedback", async (req, res) => {
    try {
      await protection.rate("feedback-ip", clientIp(req));
    } catch (error) {
      protectionFailure(res, error);
      return;
    }
    const rating = req.body?.rating === "like" || req.body?.rating === "dislike" || req.body?.rating === "clear" ? req.body.rating : "";
    if (!rating) {
      res.status(400).json({ message: "评分只能是 like、dislike 或 clear。" });
      return;
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    const messageId = typeof req.body?.messageId === "string" ? req.body.messageId : "";
    if (!sessionId || !messageId) {
      res.status(400).json({ message: "缺少会话或消息。" });
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason && (rating !== "dislike" || !(DISLIKE_REASONS as readonly string[]).includes(reason))) {
      res.status(400).json({ message: "不认识的反馈原因。" });
      return;
    }
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 1000) : "";
    try {
      if (rating === "clear") {
        await deps.business.clearFeedback(visitorId(res), sessionId, messageId);
      } else {
        await deps.business.insertFeedback({
          visitorId: visitorId(res),
          sessionId,
          messageId,
          rating,
          reason: rating === "dislike" ? reason : "",
          comment: rating === "dislike" ? comment : "",
        });
      }
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof FeedbackError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      res.status(500).json({ message: "没有记下这条反馈。" });
    }
  });

  app.post("/api/chat/stop", async (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    const run = runs.get(sessionId);
    if (!run) {
      try {
        if (await protection.requestStop(visitorId(res), sessionId)) {
          res.json({ ok: true });
          return;
        }
      } catch (error) {
        protectionFailure(res, error);
        return;
      }
    }
    if (!run || run.visitorId !== visitorId(res)) {
      res.status(404).json({ message: "当前没有正在生成的回答。" });
      return;
    }
    run.stopRequested = true;
    run.abort?.();
    await run.done;
    res.json({ ok: true });
  });

  app.post("/api/chat", async (req, res) => {
    try {
      await protection.rate("chat-visitor", visitorId(res));
    } catch (error) {
      protectionFailure(res, error);
      return;
    }
    const regenerate = req.body?.regenerate === true;
    const retry = req.body?.retry === true;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (retry && regenerate) {
      res.status(400).json({ message: "重试和重新生成不能同时进行。" });
      return;
    }
    if (!regenerate && !retry && !message) {
      res.status(400).json({ message: "请输入问题。" });
      return;
    }
    if (message.length > 2000) {
      res.status(400).json({ message: "问题太长了，请缩短到 2000 字以内。" });
      return;
    }
    if (!config.chatMock && !process.env.DEEPSEEK_API_KEY) {
      res.status(503).json({ message: "服务还没有配置 DEEPSEEK_API_KEY。" });
      return;
    }

    const requestedId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    const owner = visitorId(res);
    let created = false;
    let session: LoadedSession | null = requestedId ? await deps.business.loadSession(owner, requestedId) : null;
    if (regenerate && !session) {
      res.status(404).json({ message: "没有找到这轮对话，无法重新生成。" });
      return;
    }
    if (retry && !session) {
      res.status(404).json({ message: "没有找到这轮对话，无法重试。" });
      return;
    }
    if (!session) {
      const fresh = await deps.business.createSession(owner, clientIp(req));
      created = true;
      session = { id: fresh.id, title: "", rows: [] };
    }
    if (busy.has(session.id)) {
      if (created) await deps.business.deleteSession(owner, session.id);
      res.status(409).json({ message: "上一个问题还在回答，请稍等。" });
      return;
    }

    let permit: ChatPermit;
    try {
      permit = await protection.acquire({ ip: clientIp(req), visitorId: owner, sessionId: session.id });
    } catch (error) {
      if (created) await deps.business.deleteSession(owner, session.id).catch(() => undefined);
      protectionFailure(res, error);
      return;
    }
    let stoppedBeforeStart = false;
    try {
      // 取得跨实例独占名额后重读，避免等待准入时另一轮刚完成，继续使用旧历史覆盖新消息。
      if (!created) {
        const current = await deps.business.loadSession(owner, session.id);
        if (!current) throw new ProtectionError(404, "session_missing", "没有找到这轮对话。");
        session = current;
      }
      stoppedBeforeStart = await protection.renew(permit) === "stop";
    } catch (error) {
      await protection.release(permit).catch(() => console.error("生成租约释放失败，将自动过期"));
      if (created) await deps.business.deleteSession(owner, session.id).catch(() => undefined);
      protectionFailure(res, error);
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    let finishRun: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const run = { visitorId: owner, stopRequested: stoppedBeforeStart, abort: null as (() => void) | null, done, finish: finishRun };
    runs.set(session.id, run);
    const isClosed = () => closed;
    res.on("close", () => {
      closed = true;
      if (!run.stopRequested) run.abort?.();
    });
    const ping = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    busy.add(session.id);
    let saved = false;
    let failure: string | undefined;
    let renewing = false;
    const failRun = (message: string) => { failure = message; run.abort?.(); };
    const deadline = setTimeout(() => failRun("本轮回答超时，请稍后重试。"), limits.turnTimeoutMs);
    const ipDeadline = setTimeout(() => failRun(IP_CHAT_WINDOW_EXPIRED_MESSAGE), Math.max(0, permit.ipWindowDeadline - Date.now()));
    const heartbeat = setInterval(() => {
      if (renewing || closed || failure) return;
      renewing = true;
      void protection.renew(permit).then((status) => {
        if (status === "stop") { run.stopRequested = true; run.abort?.(); }
      }).catch((error: unknown) => failRun(error instanceof ProtectionError ? error.message : "服务状态发生变化，请重新提问。"))
        .finally(() => { renewing = false; });
    }, limits.heartbeatMs);
    try {
      const profile: Profile = loadProfile(config.resumeDir);
      const turnTools = createResumeTools(lookup);
      writeEvent(res, { event: "session", data: { sessionId: session.id } }, isClosed);
      saved = await streamChat({
        business: deps.business,
        visitorId: owner,
        session,
        message,
        regenerate,
        retry,
        mock: config.chatMock,
        mockDelayMs: config.mockDelayMs,
        modelTimeoutMs: config.modelTimeoutMs,
        model,
        profile,
        tools: turnTools,
        labels: toolLabelMap(turnTools),
        ...(deps.streamFn ? { streamFn: deps.streamFn } : {}),
        emit: (event) => writeEvent(res, event, isClosed),
        isClosed,
        isStopRequested: () => run.stopRequested,
        failureReason: () => failure,
        onAgent: (agent) => {
          run.abort = () => agent.abort();
          if (run.stopRequested || isClosed() || failure) agent.abort();
        },
      });
    } catch (error) {
      if (!isClosed()) {
        console.error("回答失败", error);
        writeEvent(
          res,
          { event: "error", data: { message: sanitizeErrorMessage(error instanceof Error ? error.message : undefined) } },
          isClosed,
        );
      }
    } finally {
      busy.delete(session.id);
      runs.delete(session.id);
      clearInterval(ping);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(ipDeadline);
      await protection.release(permit).catch(() => console.error("生成租约释放失败，将自动过期"));
      if (!saved && created) {
        await deps.business.deleteSession(owner, session.id).catch(() => undefined);
      }
      finishRun();
      if (!res.writableEnded) res.end();
    }
  });

  app.use("/media", express.static(config.publicDir));
  app.get("/resume/:file", (req, res) => {
    const requested = String(req.params.file ?? "");
    const root = resolve(config.publicDir);
    const file = resolve(root, requested);
    if (
      !requested.endsWith(".pdf") ||
      requested !== basename(requested) ||
      requested.includes("..") ||
      !file.startsWith(`${root}${sep}`) ||
      !existsSync(file)
    ) {
      res.status(404).end();
      return;
    }
    let filename = requested;
    try {
      const profile = loadProfile(config.resumeDir);
      if (basename(profile.resumePdf) === requested && profile.resumePdfFilename) {
        filename = profile.resumePdfFilename;
      }
    } catch {
      filename = requested;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.sendFile(file);
  });

  if (existsSync(config.frontendDist)) {
    app.use(express.static(config.frontendDist));
    app.use((req, res, next) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      if (req.path.startsWith("/api") || req.path.startsWith("/media") || req.path.startsWith("/resume")) {
        next();
        return;
      }
      res.sendFile(join(config.frontendDist, "index.html"), (error) => {
        if (error) next();
      });
    });
  }

  return app;
}
