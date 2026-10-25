import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Profile } from "@resume/retrieval";
import { buildSystemPrompt } from "./prompt.js";
import { createToolPolicy, MAX_MODEL_REQUESTS_PER_TURN, modelMessages, RESUME_TOOL_NAMES, trustedSystemMessage } from "./agent-security.js";

const models = builtinModels();

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

/** streamSimple 在缺少密钥时会同步抛错；Agent 要求 streamFn 自己把失败放进事件流。 */
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

export function createStreamFn(): StreamFn {
  return (model, context, options) => {
    try {
      return models.streamSimple(model, context, options);
    } catch (error) {
      return errorStream(model, error);
    }
  };
}

export function createResumeAgent(options: {
  model: Model<Api>;
  profile: Profile;
  tools: AgentTool[];
  streamFn?: StreamFn;
  /** 来自数据库的原文。空数组表示新会话，由 Agent 自己写入系统提示。 */
  messages?: AgentMessage[];
}): Agent {
  const systemPrompt = buildSystemPrompt();
  const tools = options.tools.filter((tool) => RESUME_TOOL_NAMES.has(tool.name));
  const system = trustedSystemMessage(systemPrompt, tools);
  // 保留历史行的位置，避免升级后消息 id 变化导致反馈外键被级联删除。
  let hasSystem = false;
  const messages = (options.messages ?? []).map((message): AgentMessage => {
    if (message.role !== "system") return message;
    if (!hasSystem) {
      hasSystem = true;
      return { ...system, timestamp: message.timestamp };
    }
    return { role: "system", content: "", timestamp: message.timestamp };
  });
  if (!hasSystem) messages.unshift(system);
  const stream = options.streamFn ?? createStreamFn();
  let requests = 0;
  let policy = createToolPolicy();
  const agent = new Agent({
    streamFn: (model, context, streamOptions) => {
      requests += 1;
      if (requests > MAX_MODEL_REQUESTS_PER_TURN) return errorStream(model, new Error("本轮处理次数已达到上限，请缩小问题范围后重试。"));
      return stream(model, context, streamOptions);
    },
    beforeToolCall: (...args) => policy(...args),
    convertToLlm: (messages) => modelMessages(messages, system, options.profile),
    initialState: {
      systemPrompt,
      model: options.model,
      tools,
      messages,
      // 不设置 thinkingLevel。0.99.1 运行时默认是 off，类型里虽然没有 "off"。
    },
  });
  agent.subscribe((event) => {
    if (event.type === "agent_start") {
      requests = 0;
      policy = createToolPolicy();
    }
  });
  return agent;
}
