import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("防刷配置", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("提供安全默认值，可用环境变量调整请求并发和每日额度", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("CHAT_MAX_CONCURRENT", "6");
    vi.stubEnv("CHAT_DAILY_REQUEST_LIMIT", "1000");
    vi.stubEnv("QUOTA_TIME_ZONE", "UTC");
    expect(loadConfig().abuseLimits).toMatchObject({ maxConcurrent: 6, dailyRequests: 1000, quotaTimeZone: "UTC", ipChatWindowMs: 900000 });
  });

  it.each(["0", "-1", "1.5", "NaN"])("拒绝无效请求额度 %s", (value) => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("CHAT_DAILY_REQUEST_LIMIT", value);
    expect(() => loadConfig()).toThrow(/CHAT_DAILY_REQUEST_LIMIT/);
  });

  it("拒绝不存在的配额时区", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("QUOTA_TIME_ZONE", "not-a-zone");
    expect(() => loadConfig()).toThrow();
  });

  it("拒绝弱邮箱验证码密钥和无效邮件额度", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("EMAIL_AUTH_SECRET", "weak");
    expect(() => loadConfig()).toThrow(/EMAIL_AUTH_SECRET/);
    vi.stubEnv("EMAIL_AUTH_SECRET", "s".repeat(32));
    vi.stubEnv("EMAIL_DAILY_SEND_LIMIT", "0");
    expect(() => loadConfig()).toThrow(/EMAIL_DAILY_SEND_LIMIT/);
  });

  it("不再读取 ADMIN_TOKEN，留空或过短都不影响启动", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("ADMIN_TOKEN", "short");
    expect(loadConfig()).not.toHaveProperty("adminToken");
  });

  it("IP 聊天时段必须为正整数毫秒", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("CHAT_IP_WINDOW_MS", "0");
    expect(() => loadConfig()).toThrow(/CHAT_IP_WINDOW_MS/);
    vi.stubEnv("CHAT_IP_WINDOW_MS", "900000");
    expect(loadConfig().abuseLimits?.ipChatWindowMs).toBe(900000);
  });
});
