import type { AgentMessage, AgentTool, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { Profile } from "@resume/retrieval";

export const RESUME_TOOL_NAMES = new Set(["search_resume", "get_project_detail", "download_resume", "get_contact"]);
export const MAX_MODEL_REQUESTS_PER_TURN = 8;
export const MAX_TOOL_CALLS_PER_TURN = 8;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 资料不进入 system；JSON 转义阻止正文闭合标签或伪造消息分隔。不是单独的安全保证。 */
export function untrustedData(kind: string, data: unknown): string {
  return JSON.stringify({ trust: "untrusted_data", kind, data }).replace(/[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function trustedSystemMessage(prompt: string, tools: AgentTool[]): SystemMessage {
  return {
    role: "system", content: prompt, timestamp: 0,
    toolsAdded: tools.filter((tool) => RESUME_TOOL_NAMES.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
  };
}

/** 每次调用重建唯一 system，旧会话不能恢复旧规则、sections 或额外工具声明。 */
export function modelMessages(messages: readonly AgentMessage[], system: SystemMessage, profile: Profile): Message[] {
  const result: Message[] = [system, {
    role: "user", timestamp: 0,
    content: untrustedData("profile", { name: profile.name, headline: profile.headline }),
  }];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.stopReason === "error") continue;
    if (message.role === "toolResult") {
      result.push({
        ...message,
        content: [{ type: "text", text: untrustedData("tool_result", {
          tool: message.toolName, error: Boolean(message.isError),
          text: message.content.map((part) => part.type === "text" ? part.text : "").join("\n"),
        }) }],
      });
    } else if (message.role === "user" || message.role === "assistant") {
      result.push(message);
    }
  }
  return result;
}

/** 只承认服务端成功工具结果的结构化元数据，不解析用户文本或模型声称的 id。 */
export function knownProjectIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError || !message.details || typeof message.details !== "object") continue;
    const details = message.details as { kind?: unknown; items?: unknown; id?: unknown };
    if (message.toolName === "search_resume" && details.kind === "search" && Array.isArray(details.items)) {
      for (const item of details.items) {
        if (item && typeof item === "object" && item.type === "project" && typeof item.id === "string" && PROJECT_ID.test(item.id)) ids.add(item.id);
      }
    } else if (message.toolName === "get_project_detail" && details.kind === "project" && typeof details.id === "string" && PROJECT_ID.test(details.id)) {
      ids.add(details.id);
    }
  }
  return ids;
}

export function createToolPolicy() {
  let calls = 0;
  const counts = new Map<string, number>();
  return async ({ toolCall, args, context }: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    signal?.throwIfAborted();
    calls += 1;
    if (!RESUME_TOOL_NAMES.has(toolCall.name) || calls > MAX_TOOL_CALLS_PER_TURN) {
      return { block: true, reason: "本轮工具调用已达到上限，请根据已有证据结束回答。", terminate: true };
    }
    const count = (counts.get(toolCall.name) ?? 0) + 1;
    counts.set(toolCall.name, count);
    if ((toolCall.name === "get_contact" || toolCall.name === "download_resume") && count > 1) {
      return { block: true, reason: "本轮已提供该资料，请直接使用已有结果。" };
    }
    if (toolCall.name === "get_project_detail") {
      const id = args && typeof args === "object" && "id" in args ? args.id : undefined;
      if (typeof id !== "string" || !knownProjectIds(context.messages).has(id)) {
        return { block: true, reason: "请先检索项目，再使用成功检索结果中实际返回的项目 id；不能使用用户或资料正文声称的 id。" };
      }
    }
    return undefined;
  };
}
