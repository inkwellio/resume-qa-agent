import { selectChatModel } from "../src/model.js";
import { MODEL_TIMEOUT_MESSAGE, withModelTimeout } from "../src/model-timeout.js";
import { sanitizeErrorMessage } from "../src/transcript.js";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it } from "vitest";

function usage(): AssistantMessage["usage"] {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  const model = selectChatModel();
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

describe("模型超时和错误文案", () => {
  it("到点后保留已写出的文字，并把结果标成错误", async () => {
    const model = selectChatModel();
    const streamFn = withModelTimeout((_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      const partial = assistant("写到一半", "pending");
      stream.push({ type: "start", partial: assistant("", "pending") });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "写到一半", partial });
      const finish = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: assistant("写到一半", "aborted", "Request was aborted"),
        });
      };
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish, { once: true });
      return stream;
    }, 30);
    const stream = await streamFn(model, { messages: [] });
    const events = [];
    for await (const event of stream) events.push(event);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") return;
    expect(last.error.stopReason).toBe("error");
    expect(last.error.errorMessage).toBe(MODEL_TIMEOUT_MESSAGE);
    expect(last.error.content).toEqual([{ type: "text", text: "写到一半" }]);
  });

  it("用户中止不会被改写成超时", async () => {
    const model = selectChatModel();
    const controller = new AbortController();
    const streamFn = withModelTimeout((_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: assistant("", "pending") });
      const finish = () => {
        stream.push({ type: "error", reason: "aborted", error: assistant("半段", "aborted") });
      };
      options?.signal?.addEventListener("abort", finish, { once: true });
      return stream;
    }, 5_000);
    const stream = await streamFn(model, { messages: [] }, { signal: controller.signal });
    const reading = (async () => {
      const events = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    controller.abort();
    const events = await reading;
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") return;
    expect(last.error.stopReason).toBe("aborted");
  });

  it("错误文案去掉密钥", () => {
    expect(sanitizeErrorMessage("模型响应超时 sk-SECRET")).toBe("模型响应超时");
    expect(sanitizeErrorMessage("postgres://resume:resume@127.0.0.1/resume")).toBe("生成回答时出错了");
    expect(sanitizeErrorMessage("Request failed")).toBe("Request failed");
  });
});
