import { createHash, randomBytes, randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { Pool } from "pg";

export const ADMIN_SESSION_COOKIE = "resume_admin_session";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
const BCRYPT_COST = 12;
const PHONE = /^1[3-9]\d{9}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export class AdminAccountError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type AdminSyncResult = "created" | "updated" | "unchanged";

export interface AdminAccountStore {
  /**
   * 让唯一的站长账号与配置一致：没有就创建；手机号或密码变了就更新，并作废已有会话。
   * 只由命令行调用，网页上没有注册入口。密码在这里做 bcrypt。
   */
  sync(phone: string, password: string): Promise<AdminSyncResult>;
  findByPhone(phone: string): Promise<{ id: string; passwordHash: string } | null>;
  createSession(accountId: string): Promise<{ token: string }>;
  authenticate(token: string | null): Promise<{ accountId: string } | null>;
  revoke(token: string | null): Promise<void>;
}

/** 中国大陆 11 位手机号。去掉空格和短横线后再校验。 */
export function normalizeAdminPhone(value: unknown): string {
  if (typeof value !== "string") throw new AdminAccountError(400, "invalid_phone", "请输入 11 位中国大陆手机号");
  const phone = value.replace(/[\s-]/g, "");
  if (!PHONE.test(phone)) throw new AdminAccountError(400, "invalid_phone", "请输入 11 位中国大陆手机号");
  return phone;
}

export function readAdminPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 72 || value.includes("\0")) {
    throw new AdminAccountError(400, "invalid_password", "密码至少 8 位。");
  }
  return value;
}

let dummyHash: Promise<string> | null = null;
function placeholderHash(): Promise<string> {
  dummyHash ??= hash("not-a-real-admin-password", BCRYPT_COST);
  return dummyHash;
}

/** 找不到账号时也做一次比较，避免用耗时区分号是否存在。 */
export async function passwordMatches(password: string, passwordHash: string | null): Promise<boolean> {
  const digest = passwordHash ?? await placeholderHash();
  const ok = await compare(password, digest);
  return Boolean(passwordHash) && ok;
}

export function adminSessionCookie(token: string, secure: boolean, clear = false): string {
  const value = clear ? "" : token;
  return `${ADMIN_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : ADMIN_SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function readAdminSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
    let value = part.slice(separator + 1).trim();
    try { value = decodeURIComponent(value); } catch { return null; }
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueToken(): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: tokenHash(token), expiresAt: new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000) };
}

/** 工厂测试和未注入存储时使用。生产入口必须改用 Postgres。 */
export function createMemoryAdminAccounts(): AdminAccountStore {
  const accounts = new Map<string, { id: string; phone: string; passwordHash: string }>();
  const sessions = new Map<string, { accountId: string; expiresAt: number }>();
  let chain = Promise.resolve();
  const lock = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    sync(phone, password) {
      return lock(async (): Promise<AdminSyncResult> => {
        const current = [...accounts.values()][0];
        if (current && current.phone === phone && await compare(password, current.passwordHash)) return "unchanged";
        const row = { id: current?.id ?? randomUUID(), phone, passwordHash: await hash(password, BCRYPT_COST) };
        accounts.clear();
        accounts.set(phone, row);
        if (!current) return "created";
        for (const [key, session] of sessions) if (session.accountId === row.id) sessions.delete(key);
        return "updated";
      });
    },
    async findByPhone(phone) {
      const row = accounts.get(phone);
      return row ? { id: row.id, passwordHash: row.passwordHash } : null;
    },
    async createSession(accountId) {
      const issued = issueToken();
      sessions.set(issued.hash, { accountId, expiresAt: issued.expiresAt.getTime() });
      return { token: issued.token };
    },
    async authenticate(token) {
      if (!token || !TOKEN.test(token)) return null;
      const row = sessions.get(tokenHash(token));
      if (!row || row.expiresAt <= Date.now()) {
        if (row) sessions.delete(tokenHash(token));
        return null;
      }
      return { accountId: row.accountId };
    },
    async revoke(token) {
      if (token && TOKEN.test(token)) sessions.delete(tokenHash(token));
    },
  };
}

export function createPostgresAdminAccounts(pool: Pool): AdminAccountStore {
  return {
    async sync(phone, password) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // 两次部署同时执行时串行化，避免插入两行或互相覆盖。
        await client.query("LOCK TABLE admin_accounts IN EXCLUSIVE MODE");
        const found = await client.query<{ id: string; phone: string; password_hash: string }>(
          "SELECT id, phone, password_hash FROM admin_accounts LIMIT 1",
        );
        const current = found.rows[0];
        let result: AdminSyncResult;
        if (!current) {
          await client.query("INSERT INTO admin_accounts (phone, password_hash) VALUES ($1, $2)", [phone, await hash(password, BCRYPT_COST)]);
          result = "created";
        } else if (current.phone === phone && await compare(password, current.password_hash)) {
          result = "unchanged";
        } else {
          await client.query("UPDATE admin_accounts SET phone = $2, password_hash = $3 WHERE id = $1", [
            current.id, phone, await hash(password, BCRYPT_COST),
          ]);
          // 账号或密码改了，旧登录全部作废。
          await client.query("DELETE FROM admin_sessions WHERE account_id = $1", [current.id]);
          result = "updated";
        }
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    },
    async findByPhone(phone) {
      const result = await pool.query<{ id: string; password_hash: string }>(
        "SELECT id, password_hash FROM admin_accounts WHERE phone = $1",
        [phone],
      );
      const row = result.rows[0];
      return row ? { id: row.id, passwordHash: row.password_hash } : null;
    },
    async createSession(accountId) {
      const issued = issueToken();
      // 只在登录时顺手清理过期会话，不在每次鉴权时写库。
      await pool.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
      await pool.query(
        `INSERT INTO admin_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
        [issued.hash, accountId, issued.expiresAt],
      );
      return { token: issued.token };
    },
    async authenticate(token) {
      if (!token || !TOKEN.test(token)) return null;
      const result = await pool.query<{ account_id: string }>(
        "SELECT account_id FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()",
        [tokenHash(token)],
      );
      const accountId = result.rows[0]?.account_id;
      return accountId ? { accountId } : null;
    },
    async revoke(token) {
      if (!token || !TOKEN.test(token)) return;
      await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [tokenHash(token)]);
    },
  };
}
