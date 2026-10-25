import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** 模型有时把检索计划写进正文。这些标签连同里面的内容都不给用户看。 */
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

/** 流还没结束时，末尾可能是被截断的 `<info`。先拿住，别闪一下标签。 */
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

/** 去掉思考标签和标签里的话。没写完的标签先不显示，避免流式输出时闪一下。 */
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

/** 把多次 text_delta 收成用户能看见的增量。思考标签可能被拆到两个包里。 */
export function createVisibleTextGate(): { push(delta: string): string; flush(): string } {
  let raw = "";
  let sent = "";
  const take = (): string => {
    const visible = stripThinkingTags(raw);
    if (!visible.startsWith(sent)) {
      sent = visible;
      return "";
    }
    const extra = visible.slice(sent.length);
    sent = visible;
    return extra;
  };
  return {
    push(delta: string): string {
      raw += delta;
      return take();
    },
    flush(): string {
      return take();
    },
  };
}

/** 入库前清掉助手正文里的思考标签。工具调用和工具结果不动。 */
export function sanitizeAssistantMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "text") return part;
      const text = stripThinkingTags(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, content } : message;
  });
}
