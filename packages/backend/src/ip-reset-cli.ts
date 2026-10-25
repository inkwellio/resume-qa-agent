import { join } from "node:path";
import { Pool } from "pg";
import { identityHash, normalizeClientIp } from "./abuse-protection.js";
import { loadEnvFile } from "./env.js";
import { resetIpChatWindow } from "./pg-abuse-protection.js";
import { repoRoot } from "./paths.js";

loadEnvFile(join(repoRoot, ".env"));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const ip = args.length === 1 ? normalizeClientIp(args[0]!) : "unknown";
if (ip === "unknown") {
  console.error("用法：pnpm ip:reset <IPv4或IPv6地址>，一次只能解除一个 IP。");
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL，未执行解除。");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    const changed = await resetIpChatWindow(pool, ip);
    console.log(changed ? "已解除该 IP 的聊天时段限制，下次成功提问起重新计时。原有每日请求计数保持不变。" : "该 IP 没有已记录的聊天时段。");
    const banned = await pool.query("SELECT 1 FROM ip_bans WHERE ip_hash = $1", [identityHash(ip)]).catch(() => null);
    if (banned?.rowCount) console.log("该 IP 仍在永久黑名单中，访问会被拒绝。请到站长后台解除禁止。");
  } catch {
    console.error("解除失败，请检查数据库连接及迁移状态。");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
