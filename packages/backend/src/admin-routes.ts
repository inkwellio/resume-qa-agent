import type { Express, Request, Response } from "express";
import {
  AdminAccountError,
  adminSessionCookie,
  normalizeAdminPhone,
  passwordMatches,
  readAdminPassword,
  readAdminSessionToken,
  type AdminAccountStore,
} from "./admin-accounts.js";
import type { AdminDirectory } from "./admin-directory.js";
import type { AbuseProtection, IpWindowSnapshot } from "./abuse-protection.js";
import { IpBanError, type IpBanRecord, type IpBanStore } from "./ip-ban.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function fail(res: Response, error: unknown): void {
  if (error instanceof AdminError || error instanceof AdminAccountError || error instanceof IpBanError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return;
  }
  if (error instanceof Error && error.message.includes("请输入有效")) {
    res.status(400).json({ message: "请输入有效的 IPv4 或 IPv6 地址。", code: "invalid_ip" });
    return;
  }
  console.error("站长后台操作失败");
  res.status(503).json({ message: "站长后台暂时不可用，请稍后再试。", code: "admin_unavailable" });
}

function pageOf(req: Request): { limit: number; offset: number } {
  return { limit: clamp(req.query.limit, 50, 1, 100), offset: clamp(req.query.offset, 0, 0, 100_000) };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function queryUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new AdminError(400, "invalid_id", `${label}不正确。`);
  return value;
}

function jsonBody(req: Request): Record<string, unknown> {
  if (!req.is("application/json")) throw new AdminError(415, "json_required", "请使用 JSON 提交。");
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new AdminError(400, "invalid_ip", "请输入有效的 IPv4 或 IPv6 地址。");
  }
  return req.body as Record<string, unknown>;
}

function readIp(body: Record<string, unknown>): string {
  if (typeof body.ip !== "string") throw new AdminError(400, "invalid_ip", "请输入有效的 IPv4 或 IPv6 地址。");
  return body.ip;
}

function readNote(body: Record<string, unknown>): string {
  if (body.note === undefined || body.note === null) return "";
  if (typeof body.note !== "string") throw new AdminError(400, "invalid_note", "备注请用一段文字。");
  const note = body.note.trim();
  if (note.length > 200) throw new AdminError(400, "invalid_note", "备注请控制在 200 字以内。");
  return note;
}

function presentIps(bans: IpBanRecord[], windows: IpWindowSnapshot[]) {
  const windowByHash = new Map(windows.map((item) => [item.ipHash, item]));
  const banByHash = new Map(bans.map((item) => [item.ipHash, item]));
  return {
    bans: bans.map((ban) => {
      const window = windowByHash.get(ban.ipHash);
      return {
        ip: ban.ip,
        note: ban.note,
        createdAt: ban.createdAt,
        window: window ? { startedAt: window.startedAt, expiresAt: window.expiresAt, exhausted: window.exhausted } : null,
      };
    }),
    windows: windows.map((window) => ({
      ipHash: window.ipHash,
      ip: banByHash.get(window.ipHash)?.ip ?? null,
      startedAt: window.startedAt,
      expiresAt: window.expiresAt,
      exhausted: window.exhausted,
      banned: banByHash.has(window.ipHash),
    })),
  };
}

function readRecord(req: Request): Record<string, unknown> {
  if (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new AdminAccountError(400, "invalid_body", "请使用 JSON 提交。");
  }
  return req.body as Record<string, unknown>;
}

const LOGIN_FAILED = new AdminAccountError(401, "admin_login_failed", "手机号或密码错误");

export function mountAdminRoutes(app: Express, options: {
  accounts: AdminAccountStore;
  cookieSecure: boolean;
  ipBans: IpBanStore;
  directory: AdminDirectory;
  protection: AbuseProtection;
}): void {
  const { accounts, cookieSecure, ipBans, directory, protection } = options;
  app.use("/api/admin", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/admin/session", async (req, res) => {
    try {
      const account = await accounts.authenticate(readAdminSessionToken(req.header("cookie")));
      const needsSetup = account ? false : (await accounts.count()) === 0;
      res.json({ authenticated: Boolean(account), needsSetup });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/setup", async (req, res) => {
    try {
      const body = readRecord(req);
      const phone = normalizeAdminPhone(body.phone);
      const password = readAdminPassword(body.password);
      if (body.confirmPassword !== password) throw new AdminAccountError(400, "password_mismatch", "两次密码不一致");
      const account = await accounts.create(phone, password);
      const session = await accounts.createSession(account.id);
      res.append("Set-Cookie", adminSessionCookie(session.token, cookieSecure));
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/login", async (req, res) => {
    try {
      const body = readRecord(req);
      let phone: string | null = null;
      try { phone = normalizeAdminPhone(body.phone); } catch { phone = null; }
      const password = typeof body.password === "string" ? body.password : "";
      const usable = Boolean(phone) && password.length >= 8 && password.length <= 72 && !password.includes("\0");
      const found = usable && phone ? await accounts.findByPhone(phone) : null;
      const matches = await passwordMatches(usable ? password : "placeholder-password", found?.passwordHash ?? null);
      if (!found || !matches) throw LOGIN_FAILED;
      const session = await accounts.createSession(found.id);
      res.append("Set-Cookie", adminSessionCookie(session.token, cookieSecure));
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/logout", async (req, res) => {
    try {
      await accounts.revoke(readAdminSessionToken(req.header("cookie")));
      res.append("Set-Cookie", adminSessionCookie("", cookieSecure, true));
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  app.use("/api/admin", async (req, res, next) => {
    try {
      const account = await accounts.authenticate(readAdminSessionToken(req.header("cookie")));
      if (!account) {
        res.status(401).json({ message: "请先登录。", code: "admin_unauthorized" });
        return;
      }
      next();
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/users", async (req, res) => {
    try {
      const page = pageOf(req);
      const result = await directory.listUsers(page);
      res.json({ ...result, ...page });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/sessions", async (req, res) => {
    try {
      const page = pageOf(req);
      const userId = queryUuid(req.query.userId, "用户编号");
      const visitorId = queryUuid(req.query.visitorId, "访客编号");
      const result = await directory.listSessions({ ...page, userId, visitorId });
      res.json({ ...result, ...page });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/sessions/:id", async (req, res) => {
    try {
      const session = await directory.getSession(String(req.params.id ?? ""));
      if (!session) {
        res.status(404).json({ message: "没有找到这轮对话。" });
        return;
      }
      res.json(session);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/ips", async (_req, res) => {
    try {
      const [bans, windows] = await Promise.all([ipBans.list(), protection.listIpWindows()]);
      res.json(presentIps(bans, windows));
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/ips/ban", async (req, res) => {
    try {
      const body = jsonBody(req);
      const ban = await ipBans.ban(readIp(body), readNote(body));
      res.json({ ok: true, ip: ban.ip, note: ban.note, createdAt: ban.createdAt });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/ips/unban", async (req, res) => {
    try {
      const ip = readIp(jsonBody(req));
      const removedBan = await ipBans.unban(ip);
      const resetWindow = await protection.resetIpWindow(ip);
      res.json({ ok: true, removedBan, resetWindow });
    } catch (error) { fail(res, error); }
  });

  app.use("/api/admin", (_req, res) => {
    res.status(404).json({ message: "没有找到这个接口。" });
  });
}
