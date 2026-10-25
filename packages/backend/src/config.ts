import { join } from "node:path";
import { repoRoot } from "./paths.js";
import { DEFAULT_ABUSE_LIMITS, type AbuseLimits } from "./abuse-protection.js";
import { normalizeEmail, type EmailAuthConfig } from "./email-auth.js";

export interface AppConfig {
  port: number;
  /** 留空则按 pi-ai 目录自动选择。 */
  deepseekModelId?: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  embeddingTimeoutMs?: number;
  /** 必须与迁移里的 vector(1024) 一致。 */
  embeddingDimension: number;
  databaseUrl: string;
  cookieSecure: boolean;
  resumeDir: string;
  publicDir: string;
  frontendDist: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  chatMock: boolean;
  mockDelayMs: number;
  /** 单次模型请求超时，到点后回答里是错误，可以重试。 */
  modelTimeoutMs: number;
  trustProxy: boolean;
  corsOrigins: string[];
  abuseLimits?: AbuseLimits;
  emailAuth?: EmailAuthConfig;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是数字`);
  return value;
}

export function loadConfig(): AppConfig {
  const modelId = process.env.DEEPSEEK_MODEL?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim() || "";
  if (!databaseUrl) {
    throw new Error("缺少 DATABASE_URL。本地可先 docker compose up -d，再把连接串写进 .env。");
  }
  const modelTimeoutMs = integer("MODEL_TIMEOUT_MS", 90_000);
  if (modelTimeoutMs < 1000) throw new Error("MODEL_TIMEOUT_MS 至少为 1000 毫秒。");
  const embeddingTimeoutMs = integer("EMBEDDING_TIMEOUT_MS", 15_000);
  if (!Number.isInteger(embeddingTimeoutMs) || embeddingTimeoutMs < 1) throw new Error("EMBEDDING_TIMEOUT_MS 必须为正整数毫秒。");
  const positive = (name: string, fallback: number) => {
    const value = integer(name, fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须为正整数`);
    return value;
  };
  const quotaTimeZone = process.env.QUOTA_TIME_ZONE?.trim() || DEFAULT_ABUSE_LIMITS.quotaTimeZone;
  const authSecret = process.env.EMAIL_AUTH_SECRET?.trim() || "";
  if (authSecret && authSecret.length < 32) throw new Error("EMAIL_AUTH_SECRET 至少需要 32 个字符。");
  const accountName = process.env.ALIYUN_DM_ACCOUNT_NAME?.trim() || "";
  if (accountName) normalizeEmail(accountName);
  new Intl.DateTimeFormat("en", { timeZone: quotaTimeZone }).format();
  const abuseLimits: AbuseLimits = {
    ...DEFAULT_ABUSE_LIMITS,
    apiRateMax: positive("API_RATE_LIMIT_MAX", DEFAULT_ABUSE_LIMITS.apiRateMax),
    visitorRateMax: positive("CHAT_VISITOR_RATE_LIMIT_MAX", DEFAULT_ABUSE_LIMITS.visitorRateMax),
    maxConcurrent: positive("CHAT_MAX_CONCURRENT", DEFAULT_ABUSE_LIMITS.maxConcurrent),
    maxConcurrentPerIp: positive("CHAT_MAX_CONCURRENT_PER_IP", DEFAULT_ABUSE_LIMITS.maxConcurrentPerIp),
    maxConcurrentPerVisitor: positive("CHAT_MAX_CONCURRENT_PER_VISITOR", DEFAULT_ABUSE_LIMITS.maxConcurrentPerVisitor),
    dailyRequests: positive("CHAT_DAILY_REQUEST_LIMIT", DEFAULT_ABUSE_LIMITS.dailyRequests),
    dailyRequestsPerIp: positive("CHAT_DAILY_REQUESTS_PER_IP", DEFAULT_ABUSE_LIMITS.dailyRequestsPerIp),
    dailyRequestsPerVisitor: positive("CHAT_DAILY_REQUESTS_PER_VISITOR", DEFAULT_ABUSE_LIMITS.dailyRequestsPerVisitor),
    turnTimeoutMs: positive("CHAT_TURN_TIMEOUT_MS", DEFAULT_ABUSE_LIMITS.turnTimeoutMs),
    ipChatWindowMs: positive("CHAT_IP_WINDOW_MS", DEFAULT_ABUSE_LIMITS.ipChatWindowMs),
    quotaTimeZone,
  };
  return {
    port: integer("PORT", 8787),
    ...(modelId ? { deepseekModelId: modelId } : {}),
    embeddingBaseUrl: process.env.EMBEDDING_BASE_URL?.trim() || "https://api.siliconflow.cn/v1",
    embeddingModel: process.env.EMBEDDING_MODEL?.trim() || "BAAI/bge-m3",
    embeddingApiKey: process.env.EMBEDDING_API_KEY?.trim() || "",
    embeddingTimeoutMs,
    embeddingDimension: integer("EMBEDDING_DIMENSION", 1024),
    databaseUrl,
    cookieSecure: process.env.COOKIE_SECURE === "1",
    resumeDir: process.env.RESUME_DIR?.trim() || join(repoRoot, "data/resume"),
    publicDir: process.env.PUBLIC_DIR?.trim() || join(repoRoot, "data/public"),
    frontendDist: join(repoRoot, "packages/frontend/dist"),
    rateLimitWindowMs: positive("RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: positive("RATE_LIMIT_MAX", 20),
    chatMock: process.env.CHAT_MOCK === "1",
    mockDelayMs: integer("CHAT_MOCK_DELAY_MS", 350),
    modelTimeoutMs,
    trustProxy: process.env.TRUST_PROXY === "1",
    corsOrigins: (process.env.CORS_ORIGIN || "http://127.0.0.1:5174,http://localhost:5174")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    abuseLimits,
    emailAuth: {
      secret: authSecret,
      accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim() || "",
      accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim() || "",
      securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN?.trim() || "",
      accountName,
      devMailer: process.env.EMAIL_DEV_MAILER === "1",
      dailySendLimit: positive("EMAIL_DAILY_SEND_LIMIT", 100),
      dailySendLimitPerIp: positive("EMAIL_DAILY_SEND_LIMIT_PER_IP", 20),
    },
  };
}
