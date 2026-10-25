import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { doneToolLabel } from "./tools.js";
import { sanitizeErrorMessage } from "./transcript.js";

/**
 * 浏览器看到的 SSE 事件。
 * 工具状态用 pending / success / error，前端再映射到 ThoughtChain 的 loading / success / error。
 * details 只出现在给界面的事件里，模型上下文只用工具返回的 content 文本。
 */
export type SseEventName =
  | "session"
  | "text_delta"
  | "tool_start"
  | "tool_progress"
  | "tool_end"
  | "done"
  | "error";

export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
}

export function formatSse(message: SseEvent): string {
  return `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  return result.details;
}

function toolPayload(
  event: { toolCallId: string; toolName: string },
  labels: ReadonlyMap<string, string>,
  status: "pending" | "success" | "error",
  extra: Record<string, unknown>,
): SseEvent["data"] {
  return {
    toolCallId: event.toolCallId,
    name: event.toolName,
    label: labels.get(event.toolName) ?? event.toolName,
    status,
    ...extra,
  };
}

/** 把 Agent.subscribe 的事件收成前端用的少数几种 SSE。用不到的事件返回 null。 */
export function mapAgentEvent(event: AgentEvent, labels: ReadonlyMap<string, string>): SseEvent | null {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" || !update.delta) return null;
      return { event: "text_delta", data: { delta: update.delta } };
    }
    case "message_end": {
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return null;
      return { event: "error", data: { message: sanitizeErrorMessage(event.message.errorMessage) } };
    }
    case "tool_execution_start":
      return {
        event: "tool_start",
        data: toolPayload(event, labels, "pending", { args: event.args }),
      };
    case "tool_execution_update": {
      const content = textFromToolResult(event.partialResult);
      const details = detailsFromToolResult(event.partialResult);
      return {
        event: "tool_progress",
        data: toolPayload(event, labels, "pending", {
          ...(content ? { content } : {}),
          ...(details !== undefined ? { details } : {}),
        }),
      };
    }
    case "tool_execution_end": {
      const rawContent = textFromToolResult(event.result);
      const content = event.isError ? sanitizeErrorMessage(rawContent) : rawContent;
      const details = event.isError ? undefined : detailsFromToolResult(event.result);
      const finished = event.isError ? undefined : doneToolLabel(event.toolName);
      return {
        event: "tool_end",
        data: toolPayload(event, labels, event.isError ? "error" : "success", {
          ...(finished ? { label: finished } : {}),
          isError: event.isError,
          ...(content ? { content } : {}),
          ...(details !== undefined ? { details } : {}),
        }),
      };
    }
    case "agent_end":
      return { event: "done", data: { reason: "agent_end" } };
    default:
      return null;
  }
}
