import { createRequire } from "node:module";
import { testDatabaseUrl } from "./test-database.mjs";

const require = createRequire(new URL("../packages/backend/package.json", import.meta.url));
const { Pool } = require("pg");
const connectionString = testDatabaseUrl();
const target = new URL(connectionString);
const name = decodeURIComponent(target.pathname.slice(1));
target.pathname = "/postgres";
const pool = new Pool({ connectionString: target.href, connectionTimeoutMillis: 5000 });
try {
  const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!existing.rowCount) {
    // name 已通过严格的标识符校验，CREATE DATABASE 不支持参数占位。
    try {
      await pool.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if (error.code !== "42P04") throw error;
    }
  }
  const testPool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await testPool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await testPool.end();
  }
  console.log(`测试库 ${name} 已就绪。`);
} catch (error) {
  console.error(`无法初始化测试库（${error.code || "连接失败"}）。请先启动 PostgreSQL；首次建库和安装 vector 扩展需要管理账号，详见 README 的测试说明。`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
