import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { createEmbeddingClient, createPgVectorStore, loadResumeDirectory, type SearchQuery } from "@resume/retrieval";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { repoRoot } from "./paths.js";
import { summarizeRetrieval, type RetrievalEvaluationRow } from "./retrieval-evaluation.js";

loadEnvFile(join(repoRoot, ".env"));
const config = loadConfig();
const keywordOnly = process.argv.includes("--keyword");
const casesArg = process.argv.indexOf("--cases");
if (casesArg >= 0 && !process.argv[casesArg + 1]) throw new Error("--cases 后需要评测文件路径");
const casesFile = casesArg < 0 ? join(repoRoot, "eval/resume-cases.json") : resolve(repoRoot, process.argv[casesArg + 1]!);
interface EvaluationCase {
  id: string;
  query: string;
  expectedIds: string[];
  filters?: Pick<SearchQuery, "type" | "techStack" | "periodFrom" | "periodTo">;
}
const cases = JSON.parse(readFileSync(casesFile, "utf8")) as EvaluationCase[];
const { chunks } = loadResumeDirectory(config.resumeDir);
const sourceIds = new Set(chunks.map((chunk) => chunk.id));
const seen = new Set<string>();
if (!Array.isArray(cases) || cases.length === 0) throw new Error("评测文件必须是非空数组");
for (const item of cases) {
  if (!item.id || seen.has(item.id) || typeof item.query !== "string" || !item.query.trim() || !Array.isArray(item.expectedIds)) {
    throw new Error("评测条目需要唯一 id、非空 query 和 expectedIds 数组");
  }
  seen.add(item.id);
  if (item.expectedIds.some((id) => !sourceIds.has(id))) throw new Error(`评测 ${item.id} 引用了当前简历不存在的条目`);
}
if (!keywordOnly && !config.embeddingApiKey) throw new Error("混合检索评测需要 EMBEDDING_API_KEY；只评关键词请加 --keyword");
const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
try {
  // 只读评测，不迁移、不入库、不改业务数据。
  const indexed = await pool.query<{ id: string }>("SELECT id FROM resume_chunks");
  const indexedIds = new Set(indexed.rows.map((row) => row.id));
  if (indexedIds.size !== sourceIds.size || [...sourceIds].some((id) => !indexedIds.has(id))) {
    throw new Error("当前索引与简历条目不一致，请先确认并执行 pnpm ingest");
  }
  const store = createPgVectorStore(pool);
  const client = createEmbeddingClient({
    baseUrl: config.embeddingBaseUrl, model: config.embeddingModel, apiKey: config.embeddingApiKey,
    ...(config.embeddingTimeoutMs !== undefined ? { timeoutMs: config.embeddingTimeoutMs } : {}),
  });
  const rows: RetrievalEvaluationRow[] = [];
  for (const item of cases) {
    const start = performance.now();
    // 混合评测不静默降级，避免把关键词结果误报为混合检索效果。
    const vector = keywordOnly ? null : (await client.embed([item.query]))[0]!;
    const actual = await store.search({ ...item.filters, query: item.query, limit: 4 }, vector);
    rows.push({ id: item.id, query: item.query, expectedIds: item.expectedIds, actualIds: actual.map((chunk) => chunk.id), durationMs: Math.round(performance.now() - start) });
  }
  console.log(JSON.stringify({
    mode: keywordOnly ? "keyword" : "hybrid", embeddingModel: keywordOnly ? null : client.model,
    summary: summarizeRetrieval(rows), rows,
    note: "无证据题返回候选不等于模型回答错误；需检查模型能否依据正文拒答。相关性阈值应通过这些样本校准。",
  }, null, 2));
} finally {
  await pool.end();
}
