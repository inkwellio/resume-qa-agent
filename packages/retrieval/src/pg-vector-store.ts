import type { Pool, PoolClient } from "pg";
import { parsePeriod } from "./period.js";
import { segmentDocument, segmentQuery } from "./segment.js";
import type { ResumeChunk, SearchQuery } from "./types.js";
import { VECTOR_DIMENSION, type VectorRecord, type VectorStore } from "./vector-store.js";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RRF_K = 60;
const CANDIDATES = 30;

interface ChunkRow {
  id: string;
  type: ResumeChunk["type"];
  title: string;
  period: string;
  tech_stack: string[];
  text: string;
}

function assertRecords(records: VectorRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (!ID_PATTERN.test(record.id)) {
      throw new Error(`片段 id「${record.id}」不合法。id 必须来自简历原文，不能在入库时重新生成。`);
    }
    if (seen.has(record.id)) throw new Error(`重复的片段 id：${record.id}`);
    seen.add(record.id);
  }
}

function searchTokens(record: VectorRecord): string {
  return segmentDocument([record.title, record.period, record.text, ...record.tech_stack]);
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function rowToChunk(row: ChunkRow): ResumeChunk {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    period: row.period,
    tech_stack: row.tech_stack ?? [],
    text: row.text,
  };
}

const FILTER_SQL = `
  ($1::text IS NULL OR type = $1)
  AND ($2::int IS NULL OR end_year >= $2)
  AND ($3::int IS NULL OR start_year <= $3)
  AND ($4::text IS NULL OR EXISTS (
    SELECT 1 FROM unnest(tech_stack) AS item WHERE lower(item) = $4
  ))
`;

async function insertRecord(client: PoolClient, record: VectorRecord): Promise<void> {
  if (record.embedding.length !== VECTOR_DIMENSION) {
    throw new Error(
      `向量维度是 ${record.embedding.length}，表结构是 vector(${VECTOR_DIMENSION})。请确认模型仍是 BAAI/bge-m3，或先改迁移再重新 pnpm ingest。`,
    );
  }
  const years = parsePeriod(record.period);
  await client.query(
    `INSERT INTO resume_chunks (
       id, type, title, period, tech_stack, text, start_year, end_year, search_tokens, embedding
     ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10::vector)
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type,
       title = EXCLUDED.title,
       period = EXCLUDED.period,
       tech_stack = EXCLUDED.tech_stack,
       text = EXCLUDED.text,
       start_year = EXCLUDED.start_year,
       end_year = EXCLUDED.end_year,
       search_tokens = EXCLUDED.search_tokens,
       embedding = EXCLUDED.embedding`,
    [
      record.id,
      record.type,
      record.title,
      record.period,
      record.tech_stack,
      record.text,
      years.startYear,
      years.endYear,
      searchTokens(record),
      toVectorLiteral(record.embedding),
    ],
  );
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 连接已经断了就不必再报一次回滚失败。
    }
    throw error;
  } finally {
    client.release();
  }
}

function filters(query: SearchQuery): [string | null, number | null, number | null, string | null] {
  return [query.type ?? null, query.periodFrom ?? null, query.periodTo ?? null, query.techStack?.trim().toLowerCase() || null];
}

export function createPgVectorStore(pool: Pool): VectorStore {
  return {
    async upsert(records: VectorRecord[]): Promise<void> {
      if (records.length === 0) return;
      assertRecords(records);
      await withTransaction(pool, async (client) => {
        for (const record of records) await insertRecord(client, record);
      });
    },

    async rebuild(records: VectorRecord[]): Promise<void> {
      if (records.length === 0) throw new Error("没有可写入的简历片段");
      assertRecords(records);
      await withTransaction(pool, async (client) => {
        await client.query("DELETE FROM resume_chunks");
        for (const record of records) await insertRecord(client, record);
      });
    },

    async delete(ids: string[]): Promise<void> {
      const safe = ids.filter((id) => ID_PATTERN.test(id));
      if (safe.length === 0) return;
      await pool.query("DELETE FROM resume_chunks WHERE id = ANY($1::text[])", [safe]);
    },

    async search(query: SearchQuery, vector: number[] | null): Promise<ResumeChunk[]> {
      const limit = Math.min(Math.max(query.limit ?? 6, 1), 20);
      const text = query.query.trim();
      const filterValues = filters(query);
      if (!text) {
        const result = await pool.query<ChunkRow>(
          `SELECT id, type, title, period, tech_stack, text
           FROM resume_chunks
           WHERE ${FILTER_SQL}
           ORDER BY id
           LIMIT $5`,
          [...filterValues, limit],
        );
        return result.rows.map(rowToChunk);
      }
      if (vector && vector.length !== VECTOR_DIMENSION) {
        throw new Error(
          `查询向量维度是 ${vector.length}，索引是 ${VECTOR_DIMENSION}。维度不一致，请重新运行 pnpm ingest。`,
        );
      }
      const tsquery = segmentQuery(text);
      if (vector && tsquery) {
        const result = await pool.query<ChunkRow>(
          `WITH filtered AS (
             SELECT id, embedding, search_tsv
             FROM resume_chunks
             WHERE ${FILTER_SQL}
           ),
           semantic AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $5::vector) AS rank
             FROM filtered
             ORDER BY embedding <=> $5::vector
             LIMIT ${CANDIDATES}
           ),
           keyword AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, to_tsquery('simple', $6)) DESC) AS rank
             FROM filtered
             WHERE search_tsv @@ to_tsquery('simple', $6)
             ORDER BY ts_rank_cd(search_tsv, to_tsquery('simple', $6)) DESC
             LIMIT ${CANDIDATES}
           )
           SELECT c.id, c.type, c.title, c.period, c.tech_stack, c.text
           FROM resume_chunks c
           LEFT JOIN semantic s ON s.id = c.id
           LEFT JOIN keyword k ON k.id = c.id
           WHERE s.id IS NOT NULL OR k.id IS NOT NULL
           ORDER BY (COALESCE(1.0 / (${RRF_K} + s.rank), 0) + COALESCE(1.0 / (${RRF_K} + k.rank), 0)) DESC, c.id
           LIMIT $7`,
          [...filterValues, toVectorLiteral(vector), tsquery, limit],
        );
        return result.rows.map(rowToChunk);
      }
      if (vector) {
        const result = await pool.query<ChunkRow>(
          `SELECT id, type, title, period, tech_stack, text
           FROM resume_chunks
           WHERE ${FILTER_SQL}
           ORDER BY embedding <=> $5::vector, id
           LIMIT $6`,
          [...filterValues, toVectorLiteral(vector), limit],
        );
        return result.rows.map(rowToChunk);
      }
      if (!tsquery) return [];
      const result = await pool.query<ChunkRow>(
        `SELECT id, type, title, period, tech_stack, text
         FROM resume_chunks
         WHERE ${FILTER_SQL}
           AND search_tsv @@ to_tsquery('simple', $5)
         ORDER BY ts_rank_cd(search_tsv, to_tsquery('simple', $5)) DESC, id
         LIMIT $6`,
        [...filterValues, tsquery, limit],
      );
      return result.rows.map(rowToChunk);
    },
  };
}
