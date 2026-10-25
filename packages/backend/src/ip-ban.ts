import { identityHash, normalizeClientIp } from "./abuse-protection.js";

export interface IpBanRecord {
  ip: string;
  ipHash: string;
  note: string;
  createdAt: string;
}

export interface IpBanStore {
  isBanned(ip: string): Promise<boolean>;
  ban(ip: string, note: string): Promise<IpBanRecord>;
  /** 只移出黑名单，不改聊天时段。返回是否删掉了一行。 */
  unban(ip: string): Promise<boolean>;
  list(): Promise<IpBanRecord[]>;
}

export class IpBanError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function canonicalIp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) throw new IpBanError(400, "invalid_ip", "请输入有效的 IPv4 或 IPv6 地址。");
  const canonical = normalizeClientIp(trimmed);
  if (canonical === "unknown") throw new IpBanError(400, "invalid_ip", "请输入有效的 IPv4 或 IPv6 地址。");
  return canonical;
}

/** 工厂测试和未注入存储时使用。生产入口必须改用 Postgres。 */
export function createMemoryIpBans(): IpBanStore {
  const bans = new Map<string, IpBanRecord>();
  return {
    async isBanned(ip) {
      const canonical = normalizeClientIp(ip.trim());
      if (canonical === "unknown") return false;
      return bans.has(identityHash(canonical));
    },
    async ban(ip, note) {
      const canonical = canonicalIp(ip);
      const ipHash = identityHash(canonical);
      const existing = bans.get(ipHash);
      const row: IpBanRecord = {
        ip: canonical,
        ipHash,
        note: note || existing?.note || "",
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      bans.set(ipHash, row);
      return row;
    },
    async unban(ip) {
      const canonical = canonicalIp(ip);
      return bans.delete(identityHash(canonical));
    },
    async list() {
      return [...bans.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
    },
  };
}
