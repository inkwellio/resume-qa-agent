import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** 单次模型请求的默认上限。pi-ai 自带的 HTTP 超时往往是 10 分钟，聊天里太久。 */
export const DEFAULT_MODEL_TIMEOUT_MS = 90_000;

export const MODEL_TIMEOUT_MESSAGE = "模型响应超时";

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

function errorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : "模型请求失败",
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

function asTimeout(message: AssistantMessage): AssistantMessage {
  return { ...message, stopReason: "error", errorMessage: MODEL_TIMEOUT_MESSAGE };
}

/**
 * 给每一次模型请求加超时。
 * 用户点停止时父级 signal 会中止，结果仍是 stopReason "aborted"。
 * 到点则只中止这一次请求，并把结果改成 stopReason "error"，方便之后重试时从历史里拿掉。
 */
export function withModelTimeout(inner: StreamFn, timeoutMs: number): StreamFn {
  return (model, context, options) => {
    const parent = options?.signal;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onParent = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", onParent, { once: true });
    const clear = () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    };
    const rewrite = () => timedOut && !parent?.aborted;
    try {
      const started = inner(model, context, { ...options, signal: controller.signal, timeoutMs });
      if (started instanceof Promise) {
        return started.then(
          (stream) => pipe(model, stream, rewrite, clear),
          (error: unknown) => {
            clear();
            return errorStream(model, error);
          },
        );
      }
      return pipe(model, started, rewrite, clear);
    } catch (error) {
      clear();
      return errorStream(model, error);
    }
  };
}

function pipe(
  model: Model<Api>,
  source: AssistantMessageEventStream,
  rewrite: () => boolean,
  clear: () => void,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error") {
          if (rewrite()) {
            output.push({ type: "error", reason: "error", error: asTimeout(event.error) });
          } else if (event.error.stopReason === "aborted") {
            output.push({ type: "error", reason: "aborted", error: event.error });
          } else {
            output.push({ type: "error", reason: "error", error: event.error });
          }
          return;
        }
        if (event.type === "done") {
          if (rewrite()) output.push({ type: "error", reason: "error", error: asTimeout(event.message) });
          else output.push(event);
          return;
        }
        output.push(event);
      }
    } catch (error) {
      output.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : "模型请求失败",
          timestamp: Date.now(),
        },
      });
    } finally {
      clear();
      output.end();
    }
  })();
  return output;
}
