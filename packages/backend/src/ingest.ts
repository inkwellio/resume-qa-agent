/**
 * 把 data/resume 里的示例或真实简历切块、向量化，并在一个事务里重建 Postgres 里的片段。
 * 片段 id 沿用原文，不会重新生成。换 EMBEDDING_MODEL 且维度变化时，要先改迁移。
 * 用法：在 resume-agent 目录执行 pnpm ingest
 */
import { Pool } from "pg";
import { createEmbeddingClient, createPgVectorStore, loadResumeDirectory, rebuildResumeIndex, VECTOR_DIMENSION } from "@resume/retrieval";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { runMigrations } from "./migrate.js";
import { repoRoot } from "./paths.js";

loadEnvFile(join(repoRoot, ".env"));

const config = loadConfig();
if (config.embeddingDimension !== VECTOR_DIMENSION) {
  console.error(`EMBEDDING_DIMENSION=${config.embeddingDimension}，数据库列是 vector(${VECTOR_DIMENSION})。`);
  process.exit(1);
}
if (!config.embeddingApiKey) {
  console.error("缺少 EMBEDDING_API_KEY。请在 resume-agent/.env 里填写向量接口的密钥。");
  process.exit(1);
}

await runMigrations(config.databaseUrl);
const pool = new Pool({ connectionString: config.databaseUrl });
try {
  const { profile, chunks } = loadResumeDirectory(config.resumeDir);
  const client = createEmbeddingClient({
    baseUrl: config.embeddingBaseUrl,
    model: config.embeddingModel,
    apiKey: config.embeddingApiKey,
    ...(config.embeddingTimeoutMs !== undefined ? { timeoutMs: config.embeddingTimeoutMs } : {}),
  });
  const result = await rebuildResumeIndex({
    store: createPgVectorStore(pool),
    chunks,
    client,
  });
  console.log(`已为「${profile.name}」写入 ${result.count} 条片段，向量维度 ${result.dimension}。`);
} finally {
  await pool.end();
}
