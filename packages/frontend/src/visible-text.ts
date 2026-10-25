/** 与 packages/backend/src/visible-text.ts 的剥标签规则保持一致。SSE 已清过，这里再挡一层。 */
const THINKING_TAGS = new Set([
  "info",
  "think",
  "thinking",
  "reasoning",
  "thought",
  "thoughts",
  "analysis",
  "reflection",
]);

interface CompleteTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  length: number;
}

function completeTag(fragment: string): CompleteTag | null {
  const match = /^<\/?([A-Za-z][\w-]*)\b[^>]*>/.exec(fragment);
  if (!match || !match[1]) return null;
  return {
    name: match[1].toLowerCase(),
    closing: fragment.startsWith("</"),
    selfClosing: match[0].endsWith("/>"),
    length: match[0].length,
  };
}

function couldBeThinkingTag(name: string): boolean {
  if (THINKING_TAGS.has(name)) return true;
  for (const tag of THINKING_TAGS) {
    if (tag.startsWith(name)) return true;
  }
  return false;
}

function partialThinkingTag(fragment: string): boolean {
  if (!fragment.startsWith("<") || fragment.includes(">")) return false;
  const body = fragment.slice(1).replace(/^\//, "");
  if (body === "") return true;
  const match = /^([A-Za-z][\w-]*)([\s\S]*)$/.exec(body);
  if (!match || !match[1]) return false;
  const name = match[1].toLowerCase();
  const rest = match[2] ?? "";
  if (rest === "") return couldBeThinkingTag(name);
  return THINKING_TAGS.has(name);
}

function closingTagEnd(text: string, from: number, name: string): number {
  const match = new RegExp(`</${name}\\s*>`, "i").exec(text.slice(from));
  if (!match) return -1;
  return from + match.index + match[0].length;
}

/** 去掉 `<info>`、`<think>` 等思考标签和标签里的话。没闭合的也先不显示。 */
export function stripThinkingTags(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start);
    const fragment = text.slice(start);
    const tag = completeTag(fragment);
    if (!tag) {
      if (partialThinkingTag(fragment)) break;
      out += "<";
      index = start + 1;
      continue;
    }
    if (!THINKING_TAGS.has(tag.name)) {
      out += "<";
      index = start + 1;
      continue;
    }
    if (tag.closing || tag.selfClosing) {
      index = start + tag.length;
      continue;
    }
    const end = closingTagEnd(text, start + tag.length, tag.name);
    if (end < 0) break;
    index = end;
  }
  return out.replace(/^\s+/, "");
}
