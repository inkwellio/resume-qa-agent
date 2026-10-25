import type { Pool } from "pg";
import { createAliyunCodeMailer } from "./aliyun-mail.js";
import { createConsoleCodeMailer } from "./console-mail.js";
import { createPostgresEmailAuth, type CodeMailer, type EmailAuth, type EmailAuthConfig } from "./email-auth.js";

/** EMAIL_DEV_MAILER=1 时只写本进程日志；否则走阿里云 SingleSendMail。 */
export function createCodeMailer(config: EmailAuthConfig, request: typeof fetch = fetch): CodeMailer {
  return config.devMailer ? createConsoleCodeMailer() : createAliyunCodeMailer(config, request);
}

/** 按配置选择发信方式。发码和校验仍走 createPostgresEmailAuth，不因切换发信渠道改变。 */
export function createEmailAuth(pool: Pool, config: EmailAuthConfig, request: typeof fetch = fetch): EmailAuth {
  return createPostgresEmailAuth(pool, config, createCodeMailer(config, request));
}
