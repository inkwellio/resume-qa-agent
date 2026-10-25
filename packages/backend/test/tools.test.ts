import { describe, expect, it } from "vitest";
import { createResumeTools, doneToolLabel, SEARCH_RESULT_LIMIT } from "../src/tools.js";
import type { ResumeLookup } from "../src/tools.js";
import type { Profile, ResumeChunk, SearchQuery } from "@resume/retrieval";

const profile: Profile = {
  example: true,
  name: "林知夏",
  headline: "示例",
  avatar: "/media/avatar.svg",
  skills: ["React"],
  contact: {
    email: "lin.zhixia.example@example.com",
    phone: "+86 138-0000-0000",
    github: "https://github.com/example-lin-zhixia",
    website: "https://example.com/lin-zhixia",
  },
  resumePdf: "/resume/example.pdf",
  resumePdfFilename: "林知夏-简历-示例.pdf",
};

const project: ResumeChunk = {
  id: "proj-harbor",
  type: "project",
  title: "港湾协作平台",
  period: "2023.03 - 2024.01",
  tech_stack: ["React", "Node.js"],
  text: "完整项目正文，里面有一段不会放进引用摘要的后半句。".repeat(8),
};

function lookup(search: (query: SearchQuery) => Promise<ResumeChunk[]>): ResumeLookup {
  return {
    getProfile: () => profile,
    search,
    async getById(id: string) {
      return id === project.id ? project : null;
    },
  };
}

function plain(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("四个工具", () => {
  const tools = createResumeTools(
    lookup(async (query) => {
      expect(query).toMatchObject({
        query: "React",
        type: "project",
        techStack: "React",
        periodFrom: 2023,
        limit: SEARCH_RESULT_LIMIT,
      });
      return [project];
    }),
  );
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  it("名字和中文状态正好是这四个", () => {
    expect(tools.map((tool) => [tool.name, tool.label])).toEqual([
      ["search_resume", "正在查阅相关经历"],
      ["get_project_detail", "正在查阅项目详情"],
      ["download_resume", "正在获取简历文件"],
      ["get_contact", "正在获取联系方式"],
    ]);
    expect(doneToolLabel("search_resume")).toBe("已查阅相关经历");
    expect(doneToolLabel("get_project_detail")).toBe("已获取项目详情");
    expect(doneToolLabel("download_resume")).toBe("已获取简历文件");
    expect(doneToolLabel("get_contact")).toBe("已获取联系方式");
  });

  it("search_resume 给模型稳定 id 和完整正文，界面引用仍使用短摘要", async () => {
    const result = await byName.search_resume!.execute("call-1", {
      query: "React",
      type: "project",
      tech_stack: "React",
      period_from: "2023",
    });
    const content = plain(result);
    expect(content).toContain("港湾协作平台");
    expect(content).toContain(`id=${project.id}`);
    expect(content).toContain(project.text);
    expect(content).not.toContain('"kind"');
    expect(result.details).toMatchObject({
      kind: "search",
      items: [{ id: "proj-harbor", type: "project", tech_stack: ["React", "Node.js"] }],
    });
    const snippet = (result.details as { items: Array<{ snippet: string }> }).items[0]?.snippet ?? "";
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(project.text.length);
  });

  it("停止信号传递到检索，已停止时不开始检索", async () => {
    const controller = new AbortController();
    let calls = 0;
    const tool = createResumeTools({
      ...lookup(async () => []),
      async search(_query, signal) {
        calls += 1;
        expect(signal).toBe(controller.signal);
        controller.abort();
        return [project];
      },
    })[0]!;
    await expect(tool.execute("s1", { query: "React" }, controller.signal)).rejects.toThrow();
    await expect(tool.execute("s2", { query: "React" }, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("get_project_detail 按 id 返回全文，找不到时不编造", async () => {
    const found = await byName.get_project_detail!.execute("call-2", { id: "proj-harbor" });
    expect(plain(found)).toContain(project.text);
    expect(found.details).toMatchObject({ kind: "project", id: "proj-harbor", text: project.text });
    const missing = await byName.get_project_detail!.execute("call-3", { id: "nope" });
    expect(plain(missing)).toContain("没有");
    expect(missing.details).toEqual({ kind: "project_missing", id: "nope" });
  });

  it("download_resume 返回 PDF 地址", async () => {
    const result = await byName.download_resume!.execute("call-4", {});
    expect(plain(result)).toContain("/resume/example.pdf");
    expect(result.details).toEqual({
      kind: "download",
      url: "/resume/example.pdf",
      filename: "林知夏-简历-示例.pdf",
    });
  });

  it("同一轮最多检索两次、打开两个项目，查看详情的接口不限额", async () => {
    let searches = 0;
    let reads = 0;
    const limited = createResumeTools({
      getProfile: () => profile,
      async search(query) {
        searches += 1;
        expect(query.limit).toBe(SEARCH_RESULT_LIMIT);
        return [project];
      },
      async getById() {
        reads += 1;
        return project;
      },
    });
    const search = limited.find((tool) => tool.name === "search_resume");
    const detail = limited.find((tool) => tool.name === "get_project_detail");
    await search!.execute("s1", { query: "经历" });
    await search!.execute("s2", { query: "技能" });
    const blockedSearch = await search!.execute("s3", { query: "项目" });
    expect(searches).toBe(2);
    expect(plain(blockedSearch)).toContain("已经够用");
    expect(blockedSearch.details).toEqual({ kind: "search", items: [] });

    await detail!.execute("d1", { id: "proj-harbor" });
    await detail!.execute("d2", { id: "proj-harbor" });
    const blockedDetail = await detail!.execute("d3", { id: "proj-harbor" });
    expect(reads).toBe(2);
    expect(plain(blockedDetail)).toContain("已经够用");
    expect(blockedDetail.details).toEqual({ kind: "skipped" });

    let openReads = 0;
    const open = createResumeTools(
      {
        getProfile: () => profile,
        async search() {
          return [];
        },
        async getById() {
          openReads += 1;
          return project;
        },
      },
      { perTurnLimits: false },
    );
    const openDetail = open.find((tool) => tool.name === "get_project_detail");
    await openDetail!.execute("o1", { id: "proj-harbor" });
    await openDetail!.execute("o2", { id: "proj-harbor" });
    await openDetail!.execute("o3", { id: "proj-harbor" });
    expect(openReads).toBe(3);
  });

  it("get_contact 返回联系方式", async () => {
    const result = await byName.get_contact!.execute("call-5", {});
    expect(plain(result)).toContain("lin.zhixia.example@example.com");
    expect(result.details).toMatchObject({ kind: "contact", phone: "+86 138-0000-0000" });
  });
});
