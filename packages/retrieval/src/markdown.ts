import { parse } from "yaml";
import type { RawEntry } from "./types.js";

/**
 * 解析带 YAML frontmatter 的 Markdown 简历条目。
 * 主人可以按这个格式新增项目，而不是只改 JSON。
 */
export function parseMarkdownEntry(source: string, filename = "entry.md"): RawEntry {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match?.[1]) {
    throw new Error(`${filename} 需要用 --- 包住 frontmatter`);
  }
  const meta: unknown = parse(match[1]);
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`${filename} 的 frontmatter 必须是键值对`);
  }
  const record = meta as Record<string, unknown>;
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    period: record.period,
    tech_stack: record.tech_stack,
    text: (match[2] ?? "").trim(),
  };
}
