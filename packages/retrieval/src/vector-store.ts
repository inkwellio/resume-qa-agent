import type { ResumeChunk, SearchQuery } from "./types.js";

/**
 * 简历向量库。当前实现是同一个 Postgres 里的 pgvector。
 * 换别的后端时实现这一组方法即可，调用方不用改。
 *
 * id 必须来自简历原文，实现不得自己生成新的片段 id。
 */
export interface VectorRecord extends ResumeChunk {
  embedding: number[];
}

export interface VectorStore {
  /** 按 id 插入或覆盖。id 用调用方传入的稳定值。 */
  upsert(records: VectorRecord[]): Promise<void>;
  /**
   * 在一个事务里清空并写入。中途失败会回滚，旧数据还在。
   * 写入的 id 与 records 里的 id 相同。
   */
  rebuild(records: VectorRecord[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  /**
   * 关键词（已分词的全文）和向量用 RRF 融合。
   * vector 为空时只做过滤或关键词检索。
   */
  search(query: SearchQuery, vector: number[] | null): Promise<ResumeChunk[]>;
}

/** 与迁移里的 vector(1024) 一致，对应 BAAI/bge-m3。 */
export const VECTOR_DIMENSION = 1024;
