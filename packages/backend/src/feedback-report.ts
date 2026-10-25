/**
 * 打印最近的点踩，方便主人看哪些回答不准。
 * 用法：在 resume-agent 目录执行 pnpm feedback:report
 */
import { Pool } from "pg";
import { join } from "node:path";
import { createPostgresBusinessStore } from "./business-store.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { runMigrations } from "./migrate.js";
import { repoRoot } from "./paths.js";

loadEnvFile(join(repoRoot, ".env"));

const config = loadConfig();
await runMigrations(config.databaseUrl);
const pool = new Pool({ connectionString: config.databaseUrl });
try {
  const rows = await createPostgresBusinessStore(pool).recentDislikes(20);
  if (rows.length === 0) {
    console.log("还没有点踩。");
  }
  for (const row of rows) {
    const reason = row.reason || "（未填）";
    const chunks = row.chunkIds.length ? row.chunkIds.join(", ") : "（没有命中片段）";
    console.log(`[${row.createdAt}] 原因：${reason}`);
    console.log(`问题：${row.question}`);
    console.log(`命中片段：${chunks}`);
    console.log("");
  }
} finally {
  await pool.end();
}
