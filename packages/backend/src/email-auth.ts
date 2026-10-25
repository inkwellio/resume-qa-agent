import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const AUTH_COOKIE = "resume_auth";
export const CODE_TTL_SECONDS = 300;
export const RESEND_SECONDS = 60;
export const AUTH_SESSION_SECONDS = 7 * 24 * 60 * 60;

export interface EmailIdentity { email: string; visitorId: string }
export interface EmailAuth {
  readonly configured: boolean;
  authenticate(token: string | null): Promise<EmailIdentity | null>;
  sendCode(email: unknown, ip: string): Promise<void>;
  verify(email: unknown, code: unknown, ip: string): Promise<{ token: string; identity: EmailIdentity }>;
  logout(token: string | null): Promise<void>;
}
export interface CodeMailer { send(email: string, code: string): Promise<void> }
export interface EmailAuthConfig {
  secret: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  accountName: string;
  /** 为 true 时本地只打日志，不要求阿里云密钥。正式环境必须为 false。 */
  devMailer: boolean;
  dailySendLimit: number;
  dailySendLimitPerIp: number;
}

/** 密钥足够长，且要么显式开启本地日志发信，要么阿里云三项都已填写。 */
export function emailAuthConfigured(config: EmailAuthConfig): boolean {
  if (config.secret.length < 32) return false;
  if (config.devMailer) return true;
  return Boolean(config.accessKeyId && config.accessKeySecret && config.accountName);
}
export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) { super(message); }
}

/** 单个 ASCII 邮箱，拒绝地址列表、显示名、换行和超长输入。统一大小写用于登录身份。 */
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new AuthError(400, "invalid_email", "请输入有效的邮箱地址。");
  const email = value.trim().toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  if (email.length > 254 || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || domain.split(".").some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new AuthError(400, "invalid_email", "请输入有效的邮箱地址。");
  }
  return email;
}

export function authCookie(token: string, secure: boolean, clear = false): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : AUTH_SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenValid = (token: string | null): token is string => typeof token === "string" && /^[a-f0-9]{64}$/.test(token);

export function createPostgresEmailAuth(pool: Pool, config: EmailAuthConfig, mailer: CodeMailer): EmailAuth {
  const configured = emailAuthConfigured(config);
  const emailKey = (email: string) => createHmac("sha256", config.secret).update(email).digest("hex");
  const codeHash = (key: string, generation: string, code: string) => createHmac("sha256", config.secret).update(`${key}:${generation}:${code}`).digest("hex");
  const requireConfigured = () => { if (!configured) throw new AuthError(503, "email_unavailable", "邮箱验证暂未开放，请稍后再试。"); };

  // 每个窗口独立原子递增；即使后续步骤失败也不退还次数，重启、多实例共享。
  async function limit(scope: string, identity: string, seconds: number, maximum: number) {
    const result = await pool.query(
      `INSERT INTO request_rate_windows (scope, identity_hash, hits, reset_at)
       VALUES ($1, $2, 1, clock_timestamp() + $3 * interval '1 second')
       ON CONFLICT (scope, identity_hash) DO UPDATE SET
         hits = CASE WHEN request_rate_windows.reset_at <= clock_timestamp() THEN 1 ELSE request_rate_windows.hits + 1 END,
         reset_at = CASE WHEN request_rate_windows.reset_at <= clock_timestamp() THEN EXCLUDED.reset_at ELSE request_rate_windows.reset_at END
       WHERE request_rate_windows.reset_at <= clock_timestamp() OR request_rate_windows.hits < $4
       RETURNING hits`, [scope, digest(identity), seconds, maximum],
    );
    if (!result.rowCount) throw new AuthError(429, "auth_rate_limited", "验证码操作过于频繁，请稍后再试。", seconds);
  }

  return {
    configured,
    async authenticate(token) {
      if (!configured || !tokenValid(token)) return null;
      const result = await pool.query<{ email: string; visitor_id: string }>(
        `SELECT u.email, v.id AS visitor_id FROM email_auth_sessions s
         JOIN users u ON u.id = s.user_id JOIN visitors v ON v.user_id = u.id
         WHERE s.token_hash = $1 AND s.expires_at > now()`, [digest(token)],
      );
      const row = result.rows[0];
      return row ? { email: row.email, visitorId: row.visitor_id } : null;
    },
    async sendCode(value, ip) {
      requireConfigured();
      const email = normalizeEmail(value), key = emailKey(email);
      await limit("auth-send-ip-hour", ip, 3600, 10);
      await limit("auth-send-ip-day", ip, 86400, config.dailySendLimitPerIp);
      await limit("auth-send-email-hour", key, 3600, 5);
      await limit("auth-send-email-day", key, 86400, 10);
      // 通过 UPSERT 的时间条件保证两次发送至少间隔 60 秒，不能利用窗口边界连续发送。
      const generation = randomUUID(), code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const reserved = await pool.query(
        `INSERT INTO email_login_codes (email_key, generation, code_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '5 minutes')
         ON CONFLICT (email_key) DO UPDATE SET generation = EXCLUDED.generation, code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at, sent_at = now(), attempts = 0, ready = false
         WHERE email_login_codes.sent_at <= now() - interval '60 seconds' RETURNING generation`,
        [key, generation, codeHash(key, generation, code)],
      );
      if (!reserved.rowCount) throw new AuthError(429, "code_cooldown", "请等待 60 秒后再获取验证码。", RESEND_SECONDS);
      try {
        await limit("auth-send-global-day", "all", 86400, config.dailySendLimit);
        await mailer.send(email, code);
        await pool.query("UPDATE email_login_codes SET ready = true WHERE email_key = $1 AND generation = $2", [key, generation]);
      } catch (error) {
        // 保留冷却时间；失败或超时的邮件，即使随后到达，其验证码也不能登录。
        await pool.query("UPDATE email_login_codes SET ready = false, attempts = 5 WHERE email_key = $1 AND generation = $2", [key, generation]);
        if (error instanceof AuthError) throw error;
        throw new AuthError(503, "email_send_failed", "验证码发送失败，请稍后再试。");
      }
      await pool.query("DELETE FROM email_login_codes WHERE sent_at < now() - interval '1 day'");
      await pool.query("DELETE FROM email_auth_sessions WHERE expires_at < now()");
    },
    async verify(value, inputCode, ip) {
      requireConfigured();
      const email = normalizeEmail(value), key = emailKey(email);
      await limit("auth-verify-ip", ip, 900, 30);
      await limit("auth-verify-email", key, 900, 10);
      if (typeof inputCode !== "string" || !/^\d{6}$/.test(inputCode)) throw new AuthError(400, "invalid_code", "请输入 6 位数字验证码。");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '3s'");
        const found = await client.query<{ generation: string }>(
          `SELECT generation FROM email_login_codes
           WHERE email_key = $1 AND expires_at > now() AND ready AND attempts < 5 FOR UPDATE`,
          [key],
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("COMMIT");
          throw new AuthError(400, "invalid_code", "验证码错误、已过期或尝试次数过多，请重新获取。");
        }
        const matched = await client.query(
          "UPDATE email_login_codes SET attempts = attempts + 1 WHERE email_key = $1 AND code_hash = $2 RETURNING email_key",
          [key, codeHash(key, row.generation, inputCode)],
        );
        if (!matched.rowCount) {
          await client.query("UPDATE email_login_codes SET attempts = attempts + 1 WHERE email_key = $1", [key]);
          await client.query("COMMIT");
          throw new AuthError(400, "invalid_code", "验证码错误、已过期或尝试次数过多，请重新获取。");
        }
        // 消耗验证码但保留发送时间，成功登录也不能绕过 60 秒重发间隔。
        await client.query("UPDATE email_login_codes SET ready = false, attempts = 5 WHERE email_key = $1", [key]);
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
          [randomUUID(), email],
        );
        const userId = user.rows[0]!.id;
        const visitor = await client.query<{ id: string }>(
          `INSERT INTO visitors (id, user_id) VALUES ($1, $2)
           ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
          [randomUUID(), userId],
        );
        const token = randomBytes(32).toString("hex");
        await client.query(
          "INSERT INTO email_auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')",
          [digest(token), userId],
        );
        await client.query("COMMIT");
        return { token, identity: { email, visitorId: visitor.rows[0]!.id } };
      } catch (error) {
        if (!(error instanceof AuthError)) await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async logout(token) {
      if (tokenValid(token)) await pool.query("DELETE FROM email_auth_sessions WHERE token_hash = $1", [digest(token)]);
    },
  };
}
