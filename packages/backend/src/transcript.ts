import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { doneToolLabel } from "./tools.js";
import { stripThinkingTags } from "./visible-text.js";

/** 与安装的 @earendil-works/pi-agent-core 版本对齐。升级库之后要另写数据迁移。 */
export const AGENT_FORMAT_VERSION = "pi-agent-core@0.99.1";

export interface UiDetails {
  toolCallId: string;
  toolName: string;
  label: string;
  isError: boolean;
  details: unknown;
}

export interface StoredRow {
  id: string;
  seq: number;
  formatVersion: string;
  agentMessage: AgentMessage;
  uiDetails: UiDetails | null;
}

export interface PublicToolStep {
  toolCallId: string;
  name: string;
  label: string;
  status: "pending" | "success" | "error";
  content?: string;
  details?: unknown;
}

export interface PublicMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: PublicToolStep[];
  rating?: "like" | "dislike" | null;
  /** 用户停止生成。对应助手消息 stopReason === "aborted"。 */
  stopped?: boolean;
  /** 已去掉密钥和堆栈的失败原因。对应 stopReason === "error"。 */
  error?: string;
}

const SECRET = /sk-[A-Za-z0-9]|api[_-]?key|bearer\s+\S|postgres:\/\/\S+|DEEPSEEK_API_KEY|EMBEDDING_API_KEY/i;

/** 失败原因可以给访客看，但不能带上密钥、连接串或一长串堆栈。 */
export function sanitizeErrorMessage(raw: string | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (/timeout|timed out|超时/i.test(text)) return "模型响应超时";
  if (/network|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|Failed to fetch|网络/i.test(text)) {
    return "网络连接中断了";
  }
  if (!text || SECRET.test(text) || text.length > 180) return "生成回答时出错了";
  return text;
}

export function assertFormatVersions(rows: readonly StoredRow[]): void {
  for (const row of rows) {
    if (row.formatVersion !== AGENT_FORMAT_VERSION) {
      throw new Error(
        `这段对话是用 ${row.formatVersion} 保存的，当前助手只认识 ${AGENT_FORMAT_VERSION}。请新开一轮。`,
      );
    }
  }
}

export function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  if (message.role === "assistant" || message.role === "toolResult") {
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function rowsFromAgentMessages(
  messages: readonly AgentMessage[],
  labels: ReadonlyMap<string, string>,
  previous: readonly StoredRow[] = [],
): StoredRow[] {
  return messages.map((message, seq) => {
    const prior = previous[seq];
    // 只在前缀上沿用 id。后面的轮次会整段重写消息，评分挂在 message_id 上，id 一变按钮就会灭。
    const id = prior && prior.agentMessage.role === message.role ? prior.id : randomUUID();
    return {
      id,
      seq,
      formatVersion: AGENT_FORMAT_VERSION,
      agentMessage: message,
      uiDetails: uiDetailsFor(message, labels),
    };
  });
}

function uiDetailsFor(message: AgentMessage, labels: ReadonlyMap<string, string>): UiDetails | null {
  if (message.role !== "toolResult") return null;
  const pending = labels.get(message.toolName) ?? message.toolName;
  const failed = Boolean(message.isError);
  return {
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    label: failed ? pending : (doneToolLabel(message.toolName) ?? pending),
    isError: failed,
    details: message.details ?? null,
  };
}

/**
 * 重试时只丢掉末尾 stopReason 为 error 的助手消息。
 * 同一轮里已经成功的工具结果留着，这样 continue() 可以从用户消息或工具结果接着跑。
 */
export function dropTrailingErrors(rows: readonly StoredRow[]): StoredRow[] {
  const next = [...rows];
  while (next.length > 0) {
    const last = next[next.length - 1]?.agentMessage;
    if (last?.role === "assistant" && last.stopReason === "error") {
      next.pop();
      continue;
    }
    break;
  }
  return next;
}

/** 重新生成时，上下文停在最后一条用户问题上，丢掉这之后的助手回答和工具结果。 */
export function trimToLastUser(rows: readonly StoredRow[]): StoredRow[] | null {
  let lastUser = -1;
  rows.forEach((row, index) => {
    if (row.agentMessage.role === "user") lastUser = index;
  });
  if (lastUser < 0) return null;
  return rows.slice(0, lastUser + 1);
}

export function titleFromMessages(messages: readonly AgentMessage[]): string {
  const user = messages.find((message) => message.role === "user");
  if (!user) return "";
  const text = messageText(user).trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function lastAssistantId(rows: readonly StoredRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.agentMessage.role === "assistant") return row.id;
  }
  return null;
}

export interface VisibleTurn {
  question: string;
  answer: string;
}

/** 站长查看问答：只要用户问题和助手可见正文，不要工具原文。 */
export function visibleTurns(rows: readonly StoredRow[]): VisibleTurn[] {
  const turns: VisibleTurn[] = [];
  let current: VisibleTurn | null = null;
  const commit = () => {
    if (current && (current.question || current.answer)) turns.push(current);
    current = null;
  };
  for (const message of projectMessages(rows, new Map())) {
    if (message.role === "user") {
      commit();
      current = { question: message.text, answer: "" };
      continue;
    }
    let answer = message.text.trim();
    if (!answer && message.error) answer = `（回答失败：${message.error}）`;
    else if (!answer && message.stopped) answer = "（生成已停止）";
    if (!answer) continue;
    const turn = current ?? { question: "", answer: "" };
    if (!current) current = turn;
    turn.answer = turn.answer ? `${turn.answer}\n\n${answer}` : answer;
  }
  commit();
  return turns;
}

export function projectMessages(
  rows: readonly StoredRow[],
  ratings: ReadonlyMap<string, "like" | "dislike">,
): PublicMessage[] {
  const out: PublicMessage[] = [];
  let assistant: PublicMessage | null = null;
  const flush = () => {
    if (!assistant) return;
    if (assistant.text || (assistant.tools && assistant.tools.length > 0) || assistant.stopped || assistant.error) {
      out.push(assistant);
    }
    assistant = null;
  };
  for (const row of rows) {
    const message = row.agentMessage;
    if (message.role === "system") continue;
    if (message.role === "user") {
      flush();
      out.push({ id: row.id, role: "user", text: messageText(message) });
      continue;
    }
    if (message.role !== "assistant" && message.role !== "toolResult") continue;
    if (!assistant) {
      assistant = {
        id: row.id,
        role: "assistant",
        text: "",
        tools: [],
        rating: ratings.get(row.id) ?? null,
      };
    }
    if (message.role === "assistant") {
      assistant.id = row.id;
      assistant.rating = ratings.get(row.id) ?? null;
      assistant.text += stripThinkingTags(messageText(message));
      if (message.stopReason === "aborted") {
        assistant.stopped = true;
        delete assistant.error;
      } else if (message.stopReason === "error") {
        assistant.stopped = false;
        assistant.error = sanitizeErrorMessage(message.errorMessage);
      } else {
        assistant.stopped = false;
        delete assistant.error;
      }
      continue;
    }
    const isError = row.uiDetails?.isError ?? message.isError;
    const details = isError ? undefined : row.uiDetails?.details ?? message.details;
    const content = isError ? sanitizeErrorMessage(messageText(message)) : messageText(message);
    assistant.tools = [
      ...(assistant.tools ?? []),
      {
        toolCallId: row.uiDetails?.toolCallId ?? message.toolCallId,
        name: row.uiDetails?.toolName ?? message.toolName,
        label: row.uiDetails?.label ?? message.toolName,
        status: isError ? "error" : "success",
        ...(content ? { content } : {}),
        ...(details !== undefined && details !== null ? { details } : {}),
      },
    ];
  }
  flush();
  return out;
}

export function feedbackSource(
  rows: readonly StoredRow[],
  messageId: string,
): { question: string; answer: string; chunkIds: string[]; modelId: string } | null {
  const index = rows.findIndex((row) => row.id === messageId);
  const target = index >= 0 ? rows[index] : undefined;
  if (!target || target.agentMessage.role !== "assistant") return null;
  let userIndex = -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (rows[cursor]?.agentMessage.role === "user") {
      userIndex = cursor;
      break;
    }
  }
  if (userIndex < 0) return null;
  let end = index;
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    if (rows[cursor]?.agentMessage.role === "user") break;
    end = cursor;
  }
  const slice = rows.slice(userIndex, end + 1);
  const questionRow = slice[0];
  if (!questionRow) return null;
  const answer = slice
    .filter((row) => row.agentMessage.role === "assistant")
    .map((row) => stripThinkingTags(messageText(row.agentMessage)))
    .join("");
  const chunkIds: string[] = [];
  for (const row of slice) {
    if (row.agentMessage.role !== "toolResult") continue;
    chunkIds.push(...chunkIdsFrom(row.uiDetails?.details ?? row.agentMessage.details));
  }
  return {
    question: messageText(questionRow.agentMessage),
    answer,
    chunkIds,
    modelId: target.agentMessage.model,
  };
}

function chunkIdsFrom(details: unknown): string[] {
  if (!details || typeof details !== "object" || !("kind" in details) || details.kind !== "search") return [];
  if (!("items" in details) || !Array.isArray(details.items)) return [];
  return details.items
    .map((item) => {
      if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return "";
      return item.id;
    })
    .filter(Boolean);
}
