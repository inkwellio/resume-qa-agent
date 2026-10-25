import { type Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Profile } from "@resume/retrieval";
import { createResumeAgent, createStreamFn } from "./agent.js";
import type { BusinessStore, LoadedSession } from "./business-store.js";
import { buildMockAnswer } from "./mock-chat.js";
import { withModelTimeout } from "./model-timeout.js";
import { mapAgentEvent, type SseEvent } from "./sse.js";
import { createVisibleTextGate, sanitizeAssistantMessages } from "./visible-text.js";
import {
  assertFormatVersions,
  dropTrailingErrors,
  lastAssistantId,
  messageText,
  rowsFromAgentMessages,
  titleFromMessages,
  trimToLastUser,
  type StoredRow,
} from "./transcript.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantFrom(
  model: Model<Api>,
  text: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Gate = "go" | "stop" | "drop";

function gate(options: { isClosed: () => boolean; isStopRequested: () => boolean; failureReason?: () => string | undefined }): Gate {
  if (options.isStopRequested() || options.failureReason?.()) return "stop";
  if (options.isClosed()) return "drop";
  return "go";
}

async function waitUnlessInterrupted(
  ms: number,
  options: { isClosed: () => boolean; isStopRequested: () => boolean; failureReason?: () => string | undefined },
): Promise<Gate> {
  let left = ms;
  while (left > 0) {
    const state = gate(options);
    if (state !== "go") return state;
    const step = Math.min(40, left);
    await sleep(step);
    left -= step;
  }
  return gate(options);
}

function toolName(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const call = message.content.find((part) => part.type === "toolCall");
  return call && call.type === "toolCall" ? call.name : "";
}

/** 停止时只保留已经结束的工具，再接上当前写出的半段回答。 */
function partialMockMessages(messages: readonly AgentMessage[], finished: ReadonlySet<string>, text: string, model: Model<Api>): AgentMessage[] {
  const kept: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) break;
    if (message.role === "assistant" && toolName(message)) {
      const name = toolName(message);
      const result = messages[index + 1];
      if (!finished.has(name) || result?.role !== "toolResult") break;
      kept.push(message, result);
      index += 1;
      continue;
    }
    break;
  }
  kept.push(assistantFrom(model, text, "aborted", "已停止生成"));
  return kept;
}

function lastStopReason(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

/**
 * 用数据库里的 AgentMessage 开一个新 Agent。
 * 不读取浏览器传来的历史。重新生成时上下文停在最后一条用户消息，然后 continue()。
 * 重试时只去掉末尾的错误回答，再 continue()。用户停止时把 stopReason 为 aborted 的半段回答原样写入。
 */
export async function streamChat(options: {
  business: BusinessStore;
  visitorId: string;
  session: LoadedSession;
  message: string;
  regenerate: boolean;
  retry: boolean;
  mock: boolean;
  mockDelayMs: number;
  modelTimeoutMs: number;
  model: Model<Api>;
  profile: Profile;
  tools: AgentTool[];
  labels: ReadonlyMap<string, string>;
  streamFn?: StreamFn;
  emit: (event: SseEvent) => void;
  isClosed: () => boolean;
  isStopRequested: () => boolean;
  failureReason?: () => string | undefined;
  onAgent?: (agent: Agent) => void;
}): Promise<boolean> {
  assertFormatVersions(options.session.rows);
  let history = options.session.rows;
  if (options.retry) {
    history = dropTrailingErrors(history);
    const last = history.at(-1)?.agentMessage;
    if (!last || (last.role !== "user" && last.role !== "toolResult")) {
      throw new Error("没有可以重试的回答。");
    }
  } else if (options.regenerate) {
    const trimmed = trimToLastUser(history);
    if (!trimmed) throw new Error("没有可以重新生成的问题。");
    history = trimmed;
  }
  const storedQuestion = [...history].reverse().find((row) => row.agentMessage.role === "user");
  const question = options.retry || options.regenerate ? (storedQuestion ? messageText(storedQuestion.agentMessage) : "") : options.message;
  if (!question.trim()) throw new Error("没有可以发送的问题。");

  const prior = history.map((row) => row.agentMessage);
  const withUser = options.retry || options.regenerate ? prior : [...prior, userMessage(question)];
  const visibleText = createVisibleTextGate();
  const emit = (event: SseEvent): string => {
    if (event.event !== "text_delta" || typeof event.data.delta !== "string") {
      options.emit(event);
      return "";
    }
    const delta = visibleText.push(event.data.delta);
    if (!delta) return "";
    options.emit({ event: "text_delta", data: { delta } });
    return delta;
  };
  const flushVisible = (): string => {
    const delta = visibleText.flush();
    if (!delta) return "";
    options.emit({ event: "text_delta", data: { delta } });
    return delta;
  };

  const initial = gate(options);
  if (initial === "drop") return false;
  if (initial === "stop") {
    return save(options, [...withUser, assistantFrom(options.model, "", "aborted", "已停止生成")], options.session.title, history);
  }

  if (options.mock && !options.retry && !options.regenerate && /模拟超时/.test(question)) {
    options.emit({ event: "error", data: { message: "模型响应超时" } });
    return save(options, [...withUser, assistantFrom(options.model, "", "error", "模型响应超时")], options.session.title, history);
  }

  if (options.mock) {
    const answer = buildMockAnswer(question, options.model, options.profile.name);
    const finished = new Set<string>();
    let text = "";
    for (const event of answer.events) {
      const before = gate(options);
      if (before === "drop") return false;
      if (before === "stop") {
        text += flushVisible();
        return save(options, [...withUser, ...partialMockMessages(answer.messages, finished, text, options.model)], options.session.title, history);
      }
      if (options.mockDelayMs > 0 && (event.event === "tool_end" || event.event === "text_delta")) {
        const waited = await waitUnlessInterrupted(options.mockDelayMs, options);
        if (waited === "drop") return false;
        if (waited === "stop") {
          text += flushVisible();
          return save(options, [...withUser, ...partialMockMessages(answer.messages, finished, text, options.model)], options.session.title, history);
        }
      }
      text += emit(event);
      if (event.event === "tool_end" && typeof event.data.name === "string") finished.add(event.data.name);
    }
    const after = gate(options);
    if (after === "drop") return false;
    if (after === "stop") {
      text += flushVisible();
      return save(options, [...withUser, ...partialMockMessages(answer.messages, finished, text, options.model)], options.session.title, history);
    }
    flushVisible();
    return save(options, [...withUser, ...answer.messages], options.session.title, history);
  }

  const agent = createResumeAgent({
    model: options.model,
    profile: options.profile,
    tools: options.tools,
    streamFn: withModelTimeout(options.streamFn ?? createStreamFn(), options.modelTimeoutMs),
    messages: prior,
  });
  options.onAgent?.(agent);
  const unsubscribe = agent.subscribe((event) => {
    const mapped = mapAgentEvent(event, options.labels);
    if (!mapped || mapped.event === "done") return;
    emit(mapped);
  });
  try {
    if (options.retry || options.regenerate) await agent.continue();
    else await agent.prompt(question);
  } finally {
    unsubscribe();
  }
  flushVisible();
  if (options.isClosed() && !options.isStopRequested()) return false;
  return save(options, agent.state.messages, options.session.title, history);
}

async function save(
  options: {
    business: BusinessStore;
    visitorId: string;
    session: LoadedSession;
    labels: ReadonlyMap<string, string>;
    emit: (event: SseEvent) => void;
    model: Model<Api>;
    failureReason?: () => string | undefined;
  },
  messages: readonly AgentMessage[],
  existingTitle: string,
  previous: readonly StoredRow[],
): Promise<boolean> {
  const failure = options.failureReason?.();
  const finalMessages = [...messages];
  if (failure) {
    const last = finalMessages.at(-1);
    if (last?.role === "assistant" && !last.content.some((part) => part.type === "toolCall")) {
      finalMessages[finalMessages.length - 1] = { ...last, stopReason: "error", errorMessage: failure };
    } else {
      finalMessages.push(assistantFrom(options.model, "", "error", failure));
    }
  }
  const rows = rowsFromAgentMessages(sanitizeAssistantMessages(finalMessages), options.labels, previous);
  const title = existingTitle.trim() || titleFromMessages(messages);
  await options.business.saveTranscript({
    visitorId: options.visitorId,
    sessionId: options.session.id,
    rows,
    title,
  });
  const stopReason = lastStopReason(finalMessages);
  if (failure) options.emit({ event: "error", data: { message: failure } });
  options.emit({
    event: "done",
    data: {
      reason: "agent_end",
      sessionId: options.session.id,
      messageId: lastAssistantId(rows),
      ...(stopReason ? { stopReason } : {}),
    },
  });
  return true;
}
