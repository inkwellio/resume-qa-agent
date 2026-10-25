import { join } from "node:path";
import { Pool } from "pg";
import { AdminAccountError, createPostgresAdminAccounts, normalizeAdminPhone, readAdminPassword } from "./admin-accounts.js";
import { loadEnvFile } from "./env.js";
import { runMigrations } from "./migrate.js";
import { repoRoot } from "./paths.js";

/**
 * 按配置里的 ADMIN_PHONE / ADMIN_PASSWORD 创建或更新唯一的站长账号。可重复执行：
 * 配置没变时什么都不改；改了手机号或密码就更新，并作废已有的站长登录。
 * 本地读 .env，Docker 部署读容器环境（来自 .env.production），由 deploy.sh 调用。
 */
loadEnvFile(join(repoRoot, ".env"));

const DONE: Record<string, string> = {
  created: "已创建站长账号，可以从 /admin/login 登录。",
  updated: "站长手机号或密码已按配置更新，原有站长登录已作废。",
  unchanged: "站长账号与配置一致，未做修改。",
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new AdminAccountError(1, "config", "缺少 DATABASE_URL，未创建站长账号。");
  if (!process.env.ADMIN_PHONE?.trim() || !process.env.ADMIN_PASSWORD) {
    throw new AdminAccountError(1, "config", "请在配置文件里填写 ADMIN_PHONE 和 ADMIN_PASSWORD。");
  }
  const phone = normalizeAdminPhone(process.env.ADMIN_PHONE);
  const password = readAdminPassword(process.env.ADMIN_PASSWORD);
  await runMigrations(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    const result = await createPostgresAdminAccounts(pool).sync(phone, password);
    console.log(DONE[result]);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  // 不打印原始错误，连接串和密码可能出现在里面。
  console.error(error instanceof AdminAccountError ? `站长账号未创建：${error.message}` : "站长账号未创建，请检查数据库连接及迁移状态。");
  process.exitCode = 1;
}
