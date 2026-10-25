import { createHmac, randomUUID } from "node:crypto";
import type { CodeMailer, EmailAuthConfig } from "./email-auth.js";

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** 阿里云 DirectMail 官方 RPC 签名协议，使用 HTTPS POST，敏感信息不进入 URL。 */
export function signMailParameters(parameters: Record<string, string>, secret: string): string {
  const canonical = Object.keys(parameters).sort().map((key) => `${encode(key)}=${encode(parameters[key]!)}`).join("&");
  return createHmac("sha1", `${secret}&`).update(`POST&%2F&${encode(canonical)}`).digest("base64");
}

export function createAliyunCodeMailer(config: EmailAuthConfig, request: typeof fetch = fetch): CodeMailer {
  return {
    async send(email, code) {
      const parameters: Record<string, string> = {
        AccessKeyId: config.accessKeyId, Action: "SingleSendMail", Version: "2015-11-23", Format: "JSON",
        SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0", SignatureNonce: randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), RegionId: "cn-hangzhou",
        AccountName: config.accountName, AddressType: "1", ReplyToAddress: "false", ToAddress: email,
        Subject: "简历问答 · 邮箱验证码", FromAlias: "简历问答",
        TextBody: `你的简历问答登录验证码是：${code}。\n验证码 5 分钟内有效，仅可使用一次。请勿向他人透露。\n如果不是你本人操作，请忽略本邮件。`,
        ...(config.securityToken ? { SecurityToken: config.securityToken } : {}),
      };
      const body = new URLSearchParams({ ...parameters, Signature: signMailParameters(parameters, config.accessKeySecret) });
      const response = await request("https://dm.aliyuncs.com/", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      const result = await response.json() as { Code?: string; RequestId?: string };
      // 不传播提供方响应，避免邮箱、密钥、签名或验证码经日志/API 泄露。
      if (!response.ok || result.Code || !result.RequestId) throw new Error("邮件服务发送失败");
    },
  };
}
