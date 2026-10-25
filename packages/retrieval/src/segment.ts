import { createRequire } from "node:module";
import { Jieba } from "@node-rs/jieba";

const require = createRequire(import.meta.url);
const { dict } = require("@node-rs/jieba/dict") as { dict: Uint8Array };

const jieba = Jieba.withDict(dict);

/** 丢掉 tsquery 运算符，只留中文、字母和数字。 */
const TOKEN = /^[\p{Script=Han}a-z0-9.+#_-]+$/u;

/**
 * 入库和查询用同一套分词。Postgres 的 simple 配置不会给中文切词，
 * 所以这里先切好，再用空格拼进 tsvector。
 */
export function segmentText(text: string): string[] {
  const tokens: string[] = [];
  for (const piece of jieba.cutForSearch(text, true)) {
    const token = piece.trim().toLowerCase();
    if (!token || !TOKEN.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function segmentDocument(parts: readonly string[]): string {
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const token of segmentText(part)) tokens.add(token);
  }
  return [...tokens].join(" ");
}

/** 查询侧拼成 simple 配置能执行的 OR tsquery。没有可用词时返回 null。 */
export function segmentQuery(text: string): string | null {
  const tokens = [...new Set(segmentText(text))];
  if (tokens.length === 0) return null;
  return tokens.join(" | ");
}
