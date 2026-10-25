import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildMockAnswer } from "../src/mock-chat.js";
import { AGENT_FORMAT_VERSION, projectMessages, type StoredRow } from "../src/transcript.js";
import { selectChatModel } from "../src/model.js";
import { createVisibleTextGate, sanitizeAssistantMessages, stripThinkingTags } from "../src/visible-text.js";

const leaked = "<info>用户问的是整体评价，先检索一下。</info><think>再看技能。</think>\n\n可以这样看：经验扎实。";

describe("思考标签", () => {
  it("整段去掉 info、think 和里面的话", () => {
    expect(stripThinkingTags(leaked)).toBe("可以这样看：经验扎实。");
    expect(stripThinkingTags("<INFO>秘密</INFO>短评")).toBe("短评");
    expect(stripThinkingTags("<thinking>计划</thinking>结论")).toBe("结论");
    expect(stripThinkingTags("<reasoning>x</reasoning><analysis>y</analysis>正文")).toBe("正文");
    expect(stripThinkingTags("</info>已经开始的回答")).toBe("已经开始的回答");
    expect(stripThinkingTags("<info/>后面的话")).toBe("后面的话");
    expect(stripThinkingTags("答案<info>没写完")).toBe("答案");
  });

  it("普通小于号和别的标签留着", () => {
    expect(stripThinkingTags("用 a < b 比较")).toBe("用 a < b 比较");
    expect(stripThinkingTags("见 <strong>重点</strong>")).toBe("见 <strong>重点</strong>");
    expect(stripThinkingTags("没有标签")).toBe("没有标签");
  });

  it("标签被拆进多个增量时，拼起来的可见文本不含标签", () => {
    const gate = createVisibleTextGate();
    let visible = "";
    for (const char of leaked) visible += gate.push(char);
    visible += gate.flush();
    expect(visible).toBe("可以这样看：经验扎实。");
    expect(visible).not.toMatch(/<\/?(info|think|thinking|reasoning)\b/i);
  });

  it("总评演示稿和入库文本都不带思考标签", () => {
    const answer = buildMockAnswer("这个人怎么样", {
      api: "openai-completions",
      provider: "deepseek",
      id: "deepseek-flash",
    });
    const raw = answer.events
      .filter((event) => event.event === "text_delta")
      .map((event) => event.data.delta)
      .join("");
    expect(raw).toContain("<info>");
    expect(raw).toContain("<think>");
    const gate = createVisibleTextGate();
    let visible = "";
    for (const event of answer.events) {
      if (event.event !== "text_delta" || typeof event.data.delta !== "string") continue;
      visible += gate.push(event.data.delta);
    }
    visible += gate.flush();
    expect(visible).not.toContain("<");
    expect(visible).toContain("港湾协作平台");
    expect(visible).toContain("星河科技");
    const stored = sanitizeAssistantMessages(answer.messages)
      .filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
      .flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => (part.type === "text" ? part.text : "")))
      .join("");
    expect(stored).toBe(visible);
  });

  it("重新打开旧会话时也剥掉", () => {
    const model = selectChatModel();
    const row: StoredRow = {
      id: "m1",
      seq: 1,
      formatVersion: AGENT_FORMAT_VERSION,
      uiDetails: null,
      agentMessage: {
        role: "assistant",
        content: [{ type: "text", text: "<info>先检索。</info>短评。" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    };
    expect(projectMessages([row], new Map())[0]?.text).toBe("短评。");
  });
});
