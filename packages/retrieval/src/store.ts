import { embedInBatches } from "./embeddings.js";
import type { EmbeddingClient, ResumeChunk, SearchQuery } from "./types.js";
import { VECTOR_DIMENSION, type VectorRecord, type VectorStore } from "./vector-store.js";

function embeddingText(chunk: ResumeChunk): string {
  return [chunk.title, chunk.period, chunk.tech_stack.join(" "), chunk.text].filter(Boolean).join("\n");
}

/**
 * 整表重建。id 用原文里的稳定 id。
 * 向量维度必须是 vector(1024)。换模型导致维度变化时，要先改迁移。
 */
export async function rebuildResumeIndex(options: {
  store: VectorStore;
  chunks: ResumeChunk[];
  client: EmbeddingClient;
}): Promise<{ count: number; dimension: number }> {
  if (options.chunks.length === 0) throw new Error("没有可写入的简历片段");
  const vectors = await embedInBatches(options.client, options.chunks.map(embeddingText));
  const dimension = vectors[0]?.length ?? 0;
  if (dimension !== VECTOR_DIMENSION || vectors.some((vector) => vector.length !== dimension)) {
    throw new Error(
      `当前向量维度是 ${dimension}，数据库列是 vector(${VECTOR_DIMENSION})（BAAI/bge-m3）。请先改迁移，再重新 pnpm ingest。`,
    );
  }
  const records: VectorRecord[] = options.chunks.map((chunk, index) => ({
    ...chunk,
    embedding: vectors[index] ?? [],
  }));
  await options.store.rebuild(records);
  return { count: records.length, dimension };
}

export async function searchResume(
  store: VectorStore,
  client: EmbeddingClient,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<ResumeChunk[]> {
  signal?.throwIfAborted();
  const text = query.query.trim();
  if (!text) return store.search(query, null);
  let vector: number[] | undefined;
  try {
    [vector] = await client.embed([text], signal);
    if (!vector || vector.length !== VECTOR_DIMENSION) throw new Error("查询向量维度不正确");
  } catch {
    // 用户停止必须退出；向量服务失败或超时则仍可用关键词检索。
    signal?.throwIfAborted();
    return store.search(query, null);
  }
  signal?.throwIfAborted();
  return store.search(query, vector);
}
