import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmailAuth } from "../src/code-mailer.js";
import { loadConfig } from "../src/config.js";
import { authCookie, emailAuthConfigured, normalizeEmail, type EmailAuthConfig } from "../src/email-auth.js";
import { createAliyunCodeMailer, signMailParameters } from "../src/aliyun-mail.js";

describe("邮箱输入和凭证", () => {
  it("规范化邮箱并拒绝多收件人、换行、地址显示名、畸形或超长地址", () => {
    expect(normalizeEmail(" User+job@QQ.com ")).toBe("user+job@qq.com");
    for (const input of [null, {}, "a@qq.com,b@163.com", "a@qq.com\r\nBcc:b@163.com", "a <a@qq.com>", ".a@qq.com", "a..b@qq.com", "a@-qq.com", "a@q..com", `${"a".repeat(65)}@qq.com`]) {
      expect(() => normalizeEmail(input)).toThrow();
    }
  });
  it("登录凭证仅在 HttpOnly cookie，生产 HTTPS 可添加 Secure，退出清除 cookie", () => {
    expect(authCookie("opaque", true)).toContain("HttpOnly; SameSite=Lax; Max-Age=604800; Secure");
    expect(authCookie("", false, true)).toContain("Max-Age=0");
  });
});

describe("阿里云邮件发送", () => {
  const config: EmailAuthConfig = { secret: "s".repeat(32), accessKeyId: "testid", accessKeySecret: "testsecret", securityToken: "", accountName: "login@example.com", devMailer: false, dailySendLimit: 100, dailySendLimitPerIp: 20 };
  it("符合官方 RPC 签名测试向量，包括特殊字符编码", () => {
    expect(signMailParameters({ AccessKeyId: "testid", AccountName: "<a%b'>", Action: "SingleSendMail", AddressType: "1", Format: "XML", HtmlBody: "4", RegionId: "cn-hangzhou", ReplyToAddress: "true", SignatureMethod: "HMAC-SHA1", SignatureNonce: "c1b2c332-4cfb-4a0f-b8cc-ebe622aa0a5c", SignatureVersion: "1.0", Subject: "3", TagName: "2", Timestamp: "2016-10-20T06:27:56Z", ToAddress: "1@test.com", Version: "2015-11-23" }, "testsecret")).toBe("llJfXJjBW3OacrVgxxsITgYaYm0=");
  });
  it("HTTPS POST 发送一个收件人的固定验证码正文，设置超时，不把签名或验证码放进 URL", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ RequestId: "ok" })));
    await createAliyunCodeMailer(config, request).send("user@qq.com", "012345");
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://dm.aliyuncs.com/");
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    const form = init!.body as URLSearchParams;
    expect(form.get("ToAddress")).toBe("user@qq.com");
    expect(form.get("TextBody")).toContain("012345");
    expect(form.get("ReplyToAddress")).toBe("false");
    expect(form.get("Signature")).toBeTruthy();
  });
  it("不把提供商错误里的邮箱、验证码或凭证暴露给调用方", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ Code: "Secret testsecret 012345" }), { status: 400 }));
    await expect(createAliyunCodeMailer(config, request).send("user@qq.com", "012345")).rejects.toThrow("邮件服务发送失败");
  });
});

const baseAuth = (overrides: Partial<EmailAuthConfig> = {}): EmailAuthConfig => ({
  secret: "s".repeat(32), accessKeyId: "", accessKeySecret: "", securityToken: "", accountName: "",
  devMailer: false, dailySendLimit: 100, dailySendLimitPerIp: 20, ...overrides,
});

function acceptingPool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  return { pool: { query } as unknown as Pool, query };
}

describe("开发日志发信与正式发信切换", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("只有 EMAIL_DEV_MAILER=1 打开本地发信，占位发信地址可以留下", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example/resume");
    vi.stubEnv("EMAIL_AUTH_SECRET", "s".repeat(32));
    vi.stubEnv("EMAIL_DEV_MAILER", "1");
    vi.stubEnv("ALIYUN_DM_ACCOUNT_NAME", "noreply@mail.example.com");
    vi.stubEnv("ALIBABA_CLOUD_ACCESS_KEY_ID", "");
    vi.stubEnv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "");
    expect(loadConfig().emailAuth).toMatchObject({ devMailer: true, accountName: "noreply@mail.example.com", accessKeyId: "", accessKeySecret: "" });
    for (const value of ["", "0", "true", "yes"]) {
      vi.stubEnv("EMAIL_DEV_MAILER", value);
      expect(loadConfig().emailAuth?.devMailer).toBe(false);
    }
  });

  it("本地开关打开且密钥足够时视为已配置，缺密钥或未打开时保持关闭", () => {
    expect(emailAuthConfigured(baseAuth({ devMailer: true }))).toBe(true);
    expect(emailAuthConfigured(baseAuth({ devMailer: true, secret: "short" }))).toBe(false);
    expect(emailAuthConfigured(baseAuth({ accessKeyId: "id", accessKeySecret: "secret", accountName: "login@example.com" }))).toBe(true);
    expect(emailAuthConfigured(baseAuth({ accessKeyId: "id", accessKeySecret: "secret" }))).toBe(false);
    expect(emailAuthConfigured(baseAuth())).toBe(false);
  });

  it("开发发信开启时 sendCode 成功，验证码只进进程日志且不调用阿里云", async () => {
    const request = vi.fn<typeof fetch>();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { pool, query } = acceptingPool();
    const auth = createEmailAuth(pool, baseAuth({
      devMailer: true, accountName: "noreply@mail.example.com", accessKeyId: "testid", accessKeySecret: "testsecret",
    }), request);
    expect(auth.configured).toBe(true);
    await expect(auth.sendCode(" User@QQ.com ", "127.0.0.1")).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalled();
    const line = info.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).toContain("收件邮箱 user@qq.com");
    expect(line).toMatch(/验证码 \d{6}/);
    expect(line).not.toContain("noreply@mail.example.com");
  });

  it("开发发信关闭且缺少阿里云密钥时仍返回 503 email_unavailable", async () => {
    const request = vi.fn<typeof fetch>();
    const { pool, query } = acceptingPool();
    const auth = createEmailAuth(pool, baseAuth(), request);
    expect(auth.configured).toBe(false);
    await expect(auth.sendCode("user@qq.com", "127.0.0.1")).rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    const partial = createEmailAuth(pool, baseAuth({ accessKeyId: "id", accessKeySecret: "secret" }), request);
    await expect(partial.sendCode("user@qq.com", "127.0.0.1")).rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    expect(request).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("开发发信关闭且配置齐全时 sendCode 仍走阿里云 SingleSendMail", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ RequestId: "ok" })));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const auth = createEmailAuth(acceptingPool().pool, baseAuth({
      accessKeyId: "testid", accessKeySecret: "testsecret", accountName: "login@example.com",
    }), request);
    expect(auth.configured).toBe(true);
    await expect(auth.sendCode("user@qq.com", "127.0.0.1")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://dm.aliyuncs.com/");
    const form = init!.body as URLSearchParams;
    expect(form.get("Action")).toBe("SingleSendMail");
    expect(form.get("ToAddress")).toBe("user@qq.com");
    expect(form.get("AccountName")).toBe("login@example.com");
    const code = form.get("TextBody")?.match(/\d{6}/)?.[0];
    expect(code).toBeTruthy();
    expect(info.mock.calls.flat().join("\n")).not.toContain(code!);
  });
});
