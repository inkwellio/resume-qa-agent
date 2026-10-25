import { Agent } from "@earendil-works/pi-agent-core";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createResumeAgent } from "../src/agent.js";
import { createResumeTools } from "../src/tools.js";
import type { ResumeLookup } from "../src/tools.js";
import { selectChatModel, listDeepSeekModels } from "../src/model.js";
import { mapAgentEvent, type SseEvent } from "../src/sse.js";
import { buildMockEvents } from "../src/mock-chat.js";
import type { Profile, ResumeChunk } from "@resume/retrieval";

const profile: Profile = {
  example: true,
  name: "林知夏",
  headline: "示例",
  avatar: "/media/avatar.svg",
  skills: [],
  contact: {
    email: "lin.zhixia.example@example.com",
    phone: "",
    github: "",
    website: "",
  },
  resumePdf: "/resume/example.pdf",
  resumePdfFilename: "resume.pdf",
};

const project: ResumeChunk = {
  id: "proj-harbor",
  type: "project",
  title: "港湾协作平台",
  period: "2023.03 - 2024.01",
  tech_stack: ["React"],
  text: "看板项目全文",
};

function lookup(): ResumeLookup {
  return {
    getProfile: () => profile,
    async search() {
      return [project];
    },
    async getById(id) {
      return id === project.id ? project : null;
    },
  };
}

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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  const model = selectChatModel();
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function pushText(text: string): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const pending = assistant([], "pending");
  stream.push({ type: "start", partial: pending });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: assistant([{ type: "text", text: "" }], "pending"),
  });
  let built = "";
  for (const delta of [text.slice(0, 2), text.slice(2)]) {
    built += delta;
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: assistant([{ type: "text", text: built }], "pending"),
    });
  }
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: assistant([{ type: "text", text }], "pending"),
  });
  stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text }], "stop") });
  return stream;
}

function pushTool(call: ToolCall): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const partial = assistant([call], "pending");
  stream.push({ type: "start", partial });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
  stream.push({ type: "done", reason: "toolUse", message: assistant([call], "toolUse") });
  return stream;
}

describe("模型选择", () => {
  it("默认使用 deepseek 目录里的快速模型，当前目录没有 reasoning 为 false 的条目", () => {
    const models = listDeepSeekModels();
    expect(models.map((model) => `${model.id}:${model.reasoning}`).sort()).toEqual([
      "deepseek-flash:true",
      "deepseek-v4-pro:true",
    ]);
    const selected = selectChatModel();
    expect(selected.provider).toBe("deepseek");
    expect(selected.id).toBe("deepseek-flash");
    expect(() => selectChatModel("not-a-model")).toThrow(/DEEPSEEK_MODEL/);
  });

  it("旧会话里的系统提示会换成当前这一版", () => {
    const agent = createResumeAgent({
      model: selectChatModel(),
      profile,
      tools: createResumeTools(lookup()),
      messages: [{ role: "system", content: "旧提示", timestamp: 0 }],
    });
    expect(agent.state.systemPrompt).toContain("两到三个亮点");
    expect(agent.state.systemPrompt).not.toContain("旧提示");
    expect(agent.state.systemPrompt).toContain("不要写 <info>");
  });
});

describe("SSE 事件映射", () => {
  it("用假的模型流跑通工具调用和文本增量，不访问真实接口", async () => {
    const tools = createResumeTools(lookup());
    const labels = new Map(tools.map((tool) => [tool.name, tool.label]));
    const model = selectChatModel();
    let turn = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: "只根据工具回答。",
        model,
        tools,
      },
      streamFn: () => {
        turn += 1;
        if (turn === 1) {
          const call: ToolCall = {
            type: "toolCall",
            id: "call-search",
            name: "search_resume",
            arguments: { query: "React", type: "project" },
          };
          return pushTool(call);
        }
        return pushText("主要是港湾协作平台。");
      },
    });
    const events: SseEvent[] = [];
    agent.subscribe((event) => {
      const mapped = mapAgentEvent(event, labels);
      if (mapped) events.push(mapped);
    });
    await agent.prompt("他做过哪些 React 项目？");

    expect(events.map((event) => event.event)).toEqual([
      "tool_start",
      "tool_end",
      "text_delta",
      "text_delta",
      "done",
    ]);
    expect(events[0]?.data).toMatchObject({
      toolCallId: "call-search",
      name: "search_resume",
      label: "正在查阅相关经历",
      status: "pending",
      args: { query: "React", type: "project" },
    });
    expect(events[0]?.data).not.toHaveProperty("label", undefined);
    expect(events[1]?.data).toMatchObject({
      status: "success",
      isError: false,
      label: "已查阅相关经历",
      details: { kind: "search", items: [{ id: "proj-harbor", title: "港湾协作平台" }] },
    });
    expect(events.filter((event) => event.event === "text_delta").map((event) => event.data.delta).join("")).toBe(
      "主要是港湾协作平台。",
    );
    expect(events.at(-1)).toEqual({ event: "done", data: { reason: "agent_end" } });
    expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(1);

    await agent.prompt("再概括一下。");
    expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("工具失败映射为 error 状态", () => {
    const mapped = mapAgentEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-x",
        toolName: "get_contact",
        result: { content: [{ type: "text", text: "失败" }], details: { kind: "contact" } },
        isError: true,
      },
      new Map([["get_contact", "正在获取联系方式"]]),
    );
    expect(mapped).toMatchObject({
      event: "tool_end",
      data: { status: "error", isError: true, label: "正在获取联系方式", content: "失败" },
    });
  });

  it("模型能从检索正文获取 id，随后按该 id 读取完整项目", async () => {
    const tools = createResumeTools(lookup());
    let calls = 0;
    const agent = createResumeAgent({
      model: selectChatModel(), profile, tools,
      streamFn: (_model, context) => {
        calls += 1;
        if (calls === 1) return pushTool({ type: "toolCall", id: "search", name: "search_resume", arguments: { query: "看板" } });
        const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
        const text = result?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
        if (calls === 2) {
          const id = /id=([A-Za-z0-9_-]+)/.exec(text)?.[1];
          expect(id).toBe(project.id);
          expect(text).toContain(project.text);
          return pushTool({ type: "toolCall", id: "detail", name: "get_project_detail", arguments: { id } });
        }
        expect(text).toContain(project.text);
        return pushText("已经查到完整项目。");
      },
    });
    await agent.prompt("请查阅看板项目详情");
    expect(calls).toBe(3);
  });

  it("工具错误内容和附带 details 不泄露上游凭据", () => {
    const event = mapAgentEvent({
      type: "tool_execution_end", toolCallId: "failed", toolName: "search_resume", isError: true,
      result: { content: [{ type: "text", text: "Bearer sk-SECRET" }], details: { raw: "sk-SECRET" } },
    }, new Map());
    expect(event?.data.content).toBe("生成回答时出错了");
    expect(JSON.stringify(event)).not.toContain("sk-SECRET");
  });

  it("演示脚本也走同一套事件名，并带上项目卡片", () => {
    const events = buildMockEvents("他 2023 年后做过哪些 React 项目？");
    expect(events[0]?.event).toBe("tool_start");
    expect(events[0]?.data.status).toBe("pending");
    expect(events.some((event) => event.event === "tool_end" && (event.data.details as { kind?: string })?.kind === "search")).toBe(
      true,
    );
    expect(events.at(-1)?.event).toBe("done");
  });
});
