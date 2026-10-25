import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dedupedCitations, selectProjectCards, visibleCitations } from "../src/answer-extras.ts";
import type { ToolStep } from "../src/types.ts";
import { stripThinkingTags } from "../src/visible-text.ts";

function step(details: ToolStep["details"], name = "search_resume"): ToolStep {
  return {
    toolCallId: `${name}-${details && "kind" in details ? details.kind : "none"}`,
    name,
    label: "已查阅",
    status: "success",
    details,
  };
}

const harbor = {
  id: "proj-harbor",
  type: "project" as const,
  title: "港湾协作平台",
  period: "2023.03 - 2024.01",
  tech_stack: ["React"],
  snippet: "看板",
};
const starmap = {
  id: "proj-starmap",
  type: "project" as const,
  title: "星图检索台",
  period: "2024.06 - 2025.02",
  tech_stack: ["Node.js"],
  snippet: "检索",
};
const ledger = {
  id: "proj-ledger",
  type: "project" as const,
  title: "票据归档小工具",
  period: "2021",
  tech_stack: ["Vue"],
  snippet: "归档",
};
const experience = {
  id: "exp-xinghe",
  type: "experience" as const,
  title: "星河科技",
  period: "2018 - 2021",
  tech_stack: ["React"],
  snippet: "前端",
};
const education = {
  id: "edu-xinghe",
  type: "education" as const,
  title: "星河大学",
  period: "2014 - 2018",
  tech_stack: [] as string[],
  snippet: "本科",
};

describe("总评展示", () => {
  it("思考标签不会出现在可见正文里", () => {
    const visible = stripThinkingTags(
      "<info>先检索。</info><think>不必打开每个项目。</think>林知夏经验扎实。",
    );
    assert.equal(visible.includes("<"), false);
    assert.match(visible, /经验扎实/);
  });

  it("引用去重，只露出正文点到的几条", () => {
    const tools = [
      step({ kind: "search", items: [harbor, starmap, ledger, experience, education] }),
      step({ kind: "search", items: [harbor, { ...education, snippet: "重复的教育" }] }),
    ];
    const text = "<info>票据归档小工具先记下。</info>亮点是港湾协作平台，另外在星河科技把 React 用熟了。";
    const visibleText = stripThinkingTags(text);
    assert.equal(dedupedCitations(tools).length, 5);
    const { shown, hiddenCount } = visibleCitations(tools, visibleText);
    assert.deepEqual(
      shown.map((item) => item.id),
      ["proj-harbor", "exp-xinghe"],
    );
    assert.equal(hiddenCount, 3);
    const cards = selectProjectCards(tools, visibleText);
    assert.deepEqual(
      cards.map((item) => item.id),
      ["proj-harbor"],
    );
  });

  it("get_project_detail 的项目即使正文没点名也出卡，检索命中本身不出卡", () => {
    const tools = [
      step({ kind: "search", items: [harbor, starmap] }),
      step(
        {
          kind: "project",
          id: starmap.id,
          title: starmap.title,
          period: starmap.period,
          tech_stack: starmap.tech_stack,
          text: "全文",
        },
        "get_project_detail",
      ),
    ];
    const cards = selectProjectCards(tools, "只谈了别的事。");
    assert.deepEqual(
      cards.map((item) => item.title),
      ["星图检索台"],
    );
  });

  it("标题竖线前的名字也算提到了这个项目", () => {
    const named = {
      ...harbor,
      id: "proj-coding",
      title: "my-coding-agent | 桌面 AI 编程工作台",
      tech_stack: ["Electron"],
    };
    const cards = selectProjectCards([step({ kind: "search", items: [named, ledger] })], "他做了 my-coding-agent。");
    assert.deepEqual(
      cards.map((item) => item.id),
      ["proj-coding"],
    );
  });
});
