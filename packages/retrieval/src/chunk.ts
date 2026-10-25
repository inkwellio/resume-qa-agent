import { CHUNK_TYPES, type ChunkType, type RawEntry, type ResumeChunk } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStack(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asType(value: unknown, id: string): ChunkType {
  if (typeof value === "string" && (CHUNK_TYPES as readonly string[]).includes(value)) {
    return value as ChunkType;
  }
  throw new Error(`条目 ${id} 的 type 必须是 ${CHUNK_TYPES.join(" | ")}`);
}

/** 把原始条目规范成检索用的片段。一条输入对应一块，不做合并。 */
export function chunkEntries(entries: RawEntry[]): ResumeChunk[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const id = asText(entry.id);
    if (!id) throw new Error(`第 ${index + 1} 条缺少 id`);
    if (!ID_PATTERN.test(id)) {
      throw new Error(`条目 ${id} 的 id 只能包含字母、数字、下划线和连字符`);
    }
    if (seen.has(id)) throw new Error(`重复的 id：${id}`);
    seen.add(id);
    const title = asText(entry.title);
    if (!title) throw new Error(`条目 ${id} 缺少 title`);
    const text = asText(entry.text);
    if (!text) throw new Error(`条目 ${id} 缺少 text`);
    return {
      id,
      type: asType(entry.type, id),
      title,
      period: asText(entry.period),
      tech_stack: asStack(entry.tech_stack),
      text,
    };
  });
}
