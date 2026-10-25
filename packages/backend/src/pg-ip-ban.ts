import type { Pool } from "pg";
import { identityHash } from "./abuse-protection.js";
import { canonicalIp, type IpBanRecord, type IpBanStore } from "./ip-ban.js";

function rowOf(row: { ip_hash: string; ip_display: string; note: string; created_at: Date | string }): IpBanRecord {
  return {
    ip: row.ip_display,
    ipHash: row.ip_hash,
    note: row.note,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export function createPostgresIpBans(pool: Pool): IpBanStore {
  return {
    async isBanned(ip) {
      const trimmed = ip.trim();
      const canonical = trimmed ? canonicalOrEmpty(trimmed) : "";
      if (!canonical) return false;
      const result = await pool.query("SELECT 1 FROM ip_bans WHERE ip_hash = $1", [identityHash(canonical)]);
      return Boolean(result.rowCount);
    },
    async ban(ip, note) {
      const canonical = canonicalIp(ip);
      const result = await pool.query<{ ip_hash: string; ip_display: string; note: string; created_at: Date | string }>(
        `INSERT INTO ip_bans (ip_hash, ip_display, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (ip_hash) DO UPDATE SET
           ip_display = EXCLUDED.ip_display,
           note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE ip_bans.note END
         RETURNING ip_hash, ip_display, note, created_at`,
        [identityHash(canonical), canonical, note],
      );
      const row = result.rows[0];
      if (!row) throw new Error("没有写入 IP 黑名单");
      return rowOf(row);
    },
    async unban(ip) {
      const canonical = canonicalIp(ip);
      const result = await pool.query("DELETE FROM ip_bans WHERE ip_hash = $1", [identityHash(canonical)]);
      return Boolean(result.rowCount);
    },
    async list() {
      const result = await pool.query<{ ip_hash: string; ip_display: string; note: string; created_at: Date | string }>(
        `SELECT ip_hash, ip_display, note, created_at
         FROM ip_bans
         ORDER BY created_at DESC
         LIMIT 200`,
      );
      return result.rows.map(rowOf);
    },
  };
}

function canonicalOrEmpty(value: string): string {
  try {
    return canonicalIp(value);
  } catch {
    return "";
  }
}
