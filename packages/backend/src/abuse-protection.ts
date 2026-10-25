import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createRateLimiter } from "./rate-limit.js";

export interface AbuseLimits {
  apiRateMax: number;
  visitorRateMax: number;
  maxConcurrent: number;
  maxConcurrentPerIp: number;
  maxConcurrentPerVisitor: number;
  dailyRequests: number;
  dailyRequestsPerIp: number;
  dailyRequestsPerVisitor: number;
  turnTimeoutMs: number;
  ipChatWindowMs: number;
  leaseMs: number;
  heartbeatMs: number;
  quotaTimeZone: string;
}

export const DEFAULT_ABUSE_LIMITS: AbuseLimits = {
  apiRateMax: 120, visitorRateMax: 10,
  maxConcurrent: 4, maxConcurrentPerIp: 2, maxConcurrentPerVisitor: 1,
  dailyRequests: 300, dailyRequestsPerIp: 50, dailyRequestsPerVisitor: 30,
  turnTimeoutMs: 120_000, leaseMs: 30_000, heartbeatMs: 5_000,
  ipChatWindowMs: 15 * 60_000,
  quotaTimeZone: "Asia/Singapore",
};

export type RateScope = "api-ip" | "stop-ip" | "chat-ip" | "chat-visitor" | "feedback-ip";
export interface ProtectionOptions {
  rateWindowMs: number;
  rateMax: number;
  limits: AbuseLimits;
}
export interface ChatAdmission { ip: string; visitorId: string; sessionId: string }
export interface ChatPermit { id: string; ipWindowDeadline: number }
export interface IpWindowSnapshot {
  ipHash: string;
  startedAt: string;
  expiresAt: string;
  exhausted: boolean;
}
export interface AbuseProtection {
  rate(scope: RateScope, key: string): Promise<void>;
  acquire(input: ChatAdmission): Promise<ChatPermit>;
  renew(permit: ChatPermit): Promise<"active" | "stop">;
  release(permit: ChatPermit): Promise<void>;
  requestStop(visitorId: string, sessionId: string): Promise<boolean>;
  /** 与服务器 CLI 相同：删掉该 IP 的时段和在途租约。每日计数不动。 */
  resetIpWindow(ip: string): Promise<boolean>;
  listIpWindows(): Promise<IpWindowSnapshot[]>;
}

export class ProtectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter: number | null = 1) {
    super(message);
  }
}

export const IP_CHAT_WINDOW_EXPIRED_MESSAGE = "该 IP 的聊天时段已结束，请联系站点管理员恢复使用。";
export function ipWindowExhausted(): ProtectionError {
  return new ProtectionError(429, "ip_time_exhausted", IP_CHAT_WINDOW_EXPIRED_MESSAGE, null);
}

/** 统一 IPv6 表示，以及 IPv4 与 IPv4-mapped IPv6，避免同一地址获得多个时段。 */
export function normalizeClientIp(value: string): string {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return "unknown";
  let canonical: string;
  try { canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1); }
  catch { return "unknown"; }
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** 会话落库用的明文地址。无法规范化时返回 null，不把 unknown 写成地址。 */
export function plaintextClientIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const canonical = normalizeClientIp(value.trim());
  return canonical === "unknown" ? null : canonical;
}

export function rateMax(scope: RateScope, options: ProtectionOptions): number {
  if (scope === "api-ip" || scope === "stop-ip") return options.limits.apiRateMax;
  if (scope === "chat-visitor") return options.limits.visitorRateMax;
  return options.rateMax;
}

export function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function quotaDay(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)!.value).join("-");
}

export function checkConcurrency(active: ChatAdmission[], input: ChatAdmission, limits: AbuseLimits): void {
  if (active.some((row) => row.sessionId === input.sessionId)) throw new ProtectionError(409, "session_busy", "上一个问题还在回答，请稍等。");
  if (active.length >= limits.maxConcurrent) throw new ProtectionError(429, "global_busy", "当前访问较多，请稍后再试。", 5);
  if (active.filter((row) => row.ip === input.ip).length >= limits.maxConcurrentPerIp) throw new ProtectionError(429, "ip_busy", "同时进行的提问过多，请先等待已有回答完成。", 5);
  if (active.filter((row) => row.visitorId === input.visitorId).length >= limits.maxConcurrentPerVisitor) throw new ProtectionError(429, "visitor_busy", "已有回答正在生成，请先等待或停止生成。", 5);
}

/** 仅供工厂测试和单进程嵌入使用；生产入口必须注入 Postgres 实现。 */
export function createMemoryProtection(options: ProtectionOptions, now = Date.now): AbuseProtection {
  const limiters = new Map<RateScope, ReturnType<typeof createRateLimiter>>();
  const leases = new Map<string, ChatAdmission & { expires: number; stop: boolean }>();
  const daily = new Map<string, number>();
  // 永久保留，不随每日额度、cookie 或租约清理重置。键是规范化 IP 的摘要。
  const ipWindows = new Map<string, { startedAt: number; expiresAt: number }>();
  let day = "";
  return {
    async rate(scope, key) {
      let limiter = limiters.get(scope);
      if (!limiter) {
        limiter = createRateLimiter({ windowMs: options.rateWindowMs, max: rateMax(scope, options), now });
        limiters.set(scope, limiter);
      }
      if (!limiter.allow(identityHash(key))) throw new ProtectionError(429, "rate_limited", "请求过于频繁，请稍后再试。", Math.ceil(options.rateWindowMs / 1000));
    },
    async acquire(input) {
      const time = now();
      for (const [id, lease] of leases) if (lease.expires <= time) leases.delete(id);
      const ipKey = identityHash(input.ip);
      const existingWindow = ipWindows.get(ipKey);
      const startedAt = existingWindow?.startedAt ?? time;
      const ipWindowDeadline = existingWindow?.expiresAt ?? time + options.limits.ipChatWindowMs;
      if (time >= ipWindowDeadline) throw ipWindowExhausted();
      checkConcurrency([...leases.values()], input, options.limits);
      const today = quotaDay(time, options.limits.quotaTimeZone);
      if (today !== day) { daily.clear(); day = today; }
      const targets: Array<[string, number]> = [
        ["global", options.limits.dailyRequests], [`ip:${identityHash(input.ip)}`, options.limits.dailyRequestsPerIp],
        [`visitor:${input.visitorId}`, options.limits.dailyRequestsPerVisitor],
      ];
      if (targets.some(([key, max]) => (daily.get(key) ?? 0) >= max)) throw new ProtectionError(429, "daily_quota", "今日提问额度已用完，请明天再试。", 60);
      ipWindows.set(ipKey, { startedAt, expiresAt: ipWindowDeadline });
      for (const [key] of targets) daily.set(key, (daily.get(key) ?? 0) + 1);
      const id = randomUUID();
      leases.set(id, { ...input, expires: Math.min(time + options.limits.leaseMs, ipWindowDeadline), stop: false });
      return { id, ipWindowDeadline };
    },
    async renew(permit) {
      const lease = leases.get(permit.id);
      if (lease && (ipWindows.get(identityHash(lease.ip))?.expiresAt ?? 0) <= now()) throw ipWindowExhausted();
      if (!lease || lease.expires <= now()) throw new ProtectionError(503, "lease_lost", "服务状态发生变化，请重新提问。");
      lease.expires = Math.min(now() + options.limits.leaseMs, permit.ipWindowDeadline);
      return lease.stop ? "stop" : "active";
    },
    async release(permit) { leases.delete(permit.id); },
    async requestStop(visitorId, sessionId) {
      const lease = [...leases.values()].find((row) => row.visitorId === visitorId && row.sessionId === sessionId && row.expires > now());
      if (!lease) return false;
      lease.stop = true;
      return true;
    },
    async resetIpWindow(ip) {
      const canonical = normalizeClientIp(ip);
      if (canonical === "unknown") throw new Error("请输入有效的 IPv4 或 IPv6 地址。");
      const key = identityHash(canonical);
      const existed = ipWindows.delete(key);
      for (const [id, lease] of leases) {
        if (identityHash(lease.ip) === key) leases.delete(id);
      }
      return existed;
    },
    async listIpWindows() {
      const time = now();
      return [...ipWindows.entries()].map(([ipHash, window]) => ({
        ipHash,
        startedAt: new Date(window.startedAt).toISOString(),
        expiresAt: new Date(window.expiresAt).toISOString(),
        exhausted: time >= window.expiresAt,
      })).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
  };
}
