import type { CodeMailer } from "./email-auth.js";

/**
 * 本地开发发信。验证码只写到本进程日志，不请求阿里云，调用方得到的 Promise 也没有验证码。
 * 生产不要默认使用；只有 EMAIL_DEV_MAILER=1 时才会选中它。
 */
export function createConsoleCodeMailer(write: (line: string) => void = (line) => {
  console.info(line);
}): CodeMailer {
  return {
    async send(email, code) {
      write(`[email-dev] 收件邮箱 ${email} 验证码 ${code}`);
    },
  };
}
