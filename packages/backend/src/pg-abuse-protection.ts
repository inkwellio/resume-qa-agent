import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  checkConcurrency, identityHash, ipWindowExhausted, normalizeClientIp, ProtectionError, rateMax,
  type AbuseProtection, type ChatAdmission, type ProtectionOptions,
} from "./abuse-protection.js";

/** 短事务内串行化准入，避免并发实例同时通过配额/并发检查。 */
export function createPostgresProtection(pool: Pool, options: ProtectionOptions): AbuseProtection {
  let nextCleanup = 0;
  return {
    async rate(scope, key) {
      const result = await pool.query(
        `INSERT INTO request_rate_windows (scope, identity_hash, hits, reset_at)
         VALUES ($1, $2, 1, clock_timestamp() + $3 * interval '1 millisecond')
         ON CONFLICT (scope, identity_hash) DO UPDATE SET
           hits = CASE WHEN request_rate_windows.reset_at <= clock_timestamp() THEN 1 ELSE request_rate_windows.hits + 1 END,
           reset_at = CASE WHEN request_rate_windows.reset_at <= clock_timestamp()
             THEN clock_timestamp() + $3 * interval '1 millisecond' ELSE request_rate_windows.reset_at END
         WHERE request_rate_windows.reset_at <= clock_timestamp() OR request_rate_windows.hits < $4
         RETURNING reset_at`,
        [scope, identityHash(key), options.rateWindowMs, rateMax(scope, options)],
      );
      if (!result.rowCount) throw new ProtectionError(429, "rate_limited", "请求过于频繁，请稍后再试。", Math.ceil(options.rateWindowMs / 1000));
      if (Date.now() >= nextCleanup) {
        nextCleanup = Date.now() + 60_000;
        // 有索引的过期清理，不保留曾经访问过的所有 IP。计数窗口仍按数据库时间判断。
        await pool.query("DELETE FROM request_rate_windows WHERE reset_at < clock_timestamp()");
      }
    },
    async acquire(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SELECT pg_advisory_xact_lock(1792800000)");
        await client.query("DELETE FROM active_chat_leases WHERE expires_at <= clock_timestamp()");
        const hashed: ChatAdmission = { ...input, ip: identityHash(input.ip) };
        const exhausted = await client.query(
          "SELECT 1 FROM ip_chat_windows WHERE ip_hash = $1 AND expires_at <= clock_timestamp()", [hashed.ip],
        );
        if (exhausted.rowCount) throw ipWindowExhausted();
        const active = await client.query<{ ip_hash: string; visitor_id: string; session_id: string }>(
          "SELECT ip_hash, visitor_id, session_id FROM active_chat_leases",
        );
        checkConcurrency(active.rows.map((row) => ({ ip: row.ip_hash, visitorId: row.visitor_id, sessionId: row.session_id })), hashed, options.limits);
        const targets = [
          { scope: "global", key: "global", max: options.limits.dailyRequests },
          { scope: "ip", key: hashed.ip, max: options.limits.dailyRequestsPerIp },
          { scope: "visitor", key: identityHash(input.visitorId), max: options.limits.dailyRequestsPerVisitor },
        ];
        const today = await client.query<{ day: string }>("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS day", [options.limits.quotaTimeZone]);
        const day = today.rows[0]!.day;
        await client.query("DELETE FROM chat_daily_usage WHERE day < $1::date - 2", [day]);
        for (const target of targets) {
          const usage = await client.query<{ requests: number }>(
            "SELECT requests FROM chat_daily_usage WHERE day = $1 AND scope = $2 AND identity_hash = $3",
            [day, target.scope, target.key],
          );
          if ((usage.rows[0]?.requests ?? 0) >= target.max) throw new ProtectionError(429, "daily_quota", "今日提问额度已用完，请明天再试。", 60);
        }
        await client.query(
          `INSERT INTO ip_chat_windows (ip_hash, expires_at) VALUES ($1, clock_timestamp() + $2 * interval '1 millisecond')
           ON CONFLICT (ip_hash) DO NOTHING`, [hashed.ip, options.limits.ipChatWindowMs],
        );
        const window = await client.query<{ remaining_ms: string }>(
          "SELECT extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS remaining_ms FROM ip_chat_windows WHERE ip_hash = $1", [hashed.ip],
        );
        const remainingMs = Number(window.rows[0]!.remaining_ms);
        if (remainingMs <= 0) throw ipWindowExhausted();
        for (const target of targets) {
          await client.query(
            `INSERT INTO chat_daily_usage (day, scope, identity_hash, requests) VALUES ($1, $2, $3, 1)
             ON CONFLICT (day, scope, identity_hash) DO UPDATE SET requests = chat_daily_usage.requests + 1`,
            [day, target.scope, target.key],
          );
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO active_chat_leases (id, session_id, visitor_id, ip_hash, expires_at)
           VALUES ($1, $2, $3, $4, LEAST(clock_timestamp() + $5 * interval '1 millisecond',
             (SELECT expires_at FROM ip_chat_windows WHERE ip_hash = $4)))`,
          [id, input.sessionId, input.visitorId, hashed.ip, options.limits.leaseMs],
        );
        await client.query("COMMIT");
        return { id, ipWindowDeadline: Date.now() + remainingMs };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    },
    async renew(permit) {
      const result = await pool.query<{ stop_requested: boolean; remaining_ms: string }>(
        `UPDATE active_chat_leases l SET expires_at = LEAST(clock_timestamp() + $2 * interval '1 millisecond', w.expires_at)
         FROM ip_chat_windows w WHERE l.id = $1 AND l.ip_hash = w.ip_hash
           AND l.expires_at > clock_timestamp() AND w.expires_at > clock_timestamp()
         RETURNING l.stop_requested, extract(epoch FROM (w.expires_at - clock_timestamp())) * 1000 AS remaining_ms`,
        [permit.id, options.limits.leaseMs],
      );
      if (!result.rows[0]) {
        const expired = await pool.query(
          `SELECT 1 FROM active_chat_leases l JOIN ip_chat_windows w ON w.ip_hash = l.ip_hash
           WHERE l.id = $1 AND w.expires_at <= clock_timestamp()`, [permit.id],
        );
        if (expired.rowCount) throw ipWindowExhausted();
        throw new ProtectionError(503, "lease_lost", "服务状态发生变化，请重新提问。");
      }
      // 以数据库剩余时长校正本地计时，不依赖应用服务器与数据库的时钟偏差。
      permit.ipWindowDeadline = Date.now() + Number(result.rows[0].remaining_ms);
      return result.rows[0].stop_requested ? "stop" : "active";
    },
    async release(permit) { await pool.query("DELETE FROM active_chat_leases WHERE id = $1", [permit.id]); },
    async requestStop(visitorId, sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
      const result = await pool.query(
        "UPDATE active_chat_leases SET stop_requested = true WHERE visitor_id = $1 AND session_id = $2 AND expires_at > clock_timestamp() RETURNING id",
        [visitorId, sessionId],
      );
      return Boolean(result.rowCount);
    },
    async resetIpWindow(ip) {
      return resetIpChatWindow(pool, ip);
    },
    async listIpWindows() {
      const result = await pool.query<{ ip_hash: string; started_at: Date | string; expires_at: Date | string; exhausted: boolean }>(
        `SELECT ip_hash, started_at, expires_at, expires_at <= clock_timestamp() AS exhausted
         FROM ip_chat_windows
         ORDER BY started_at DESC
         LIMIT 200`,
      );
      return result.rows.map((row) => ({
        ipHash: row.ip_hash,
        startedAt: stamp(row.started_at),
        expiresAt: stamp(row.expires_at),
        exhausted: Boolean(row.exhausted),
      }));
    },
  };
}

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 仅由服务器 CLI 调用；与准入共用事务锁，撤销旧生成租约后才移除窗口。 */
export async function resetIpChatWindow(pool: Pool, ip: string): Promise<boolean> {
  const canonical = normalizeClientIp(ip);
  if (canonical === "unknown") throw new Error("请输入有效的 IPv4 或 IPv6 地址。");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT pg_advisory_xact_lock(1792800000)");
    const key = identityHash(canonical);
    await client.query("DELETE FROM active_chat_leases WHERE ip_hash = $1", [key]);
    const result = await client.query("DELETE FROM ip_chat_windows WHERE ip_hash = $1", [key]);
    await client.query("COMMIT");
    return Boolean(result.rowCount);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
