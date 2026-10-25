import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkEntries } from "../src/chunk.js";
import { parseMarkdownEntry } from "../src/markdown.js";
import { parsePeriod } from "../src/period.js";
import { loadResumeDirectory } from "../src/sources.js";

describe("切块", () => {
  it("一条经历、项目、技能组、教育经历各成一块", () => {
    const chunks = chunkEntries([
      { id: "exp-a", type: "experience", title: "公司", period: "2022.07 - 2024.05", tech_stack: ["React"], text: "经历正文" },
      { id: "proj-a", type: "project", title: "项目", period: "2024.06 - 至今", tech_stack: "Node.js, TypeScript", text: "项目正文" },
      { id: "skill-a", type: "skill", title: "前端", tech_stack: ["React"], text: "技能正文" },
      { id: "edu-a", type: "education", title: "学校", period: "2018 - 2022", text: "教育正文" },
    ]);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["experience", "project", "skill", "education"]);
    expect(chunks[1]?.tech_stack).toEqual(["Node.js", "TypeScript"]);
    expect(chunks[2]).toMatchObject({ id: "skill-a", period: "", tech_stack: ["React"] });
  });

  it("拒绝缺字段、坏类型和重复 id", () => {
    expect(() => chunkEntries([{ type: "project", title: "无 id", text: "正文" }])).toThrow(/缺少 id/);
    expect(() => chunkEntries([{ id: "有空格", type: "project", title: "标题", text: "正文" }])).toThrow(/id/);
    expect(() => chunkEntries([{ id: "x", type: "hobby", title: "标题", text: "正文" }])).toThrow(/type/);
    expect(() =>
      chunkEntries([
        { id: "same", type: "project", title: "一", text: "正文" },
        { id: "same", type: "project", title: "二", text: "正文" },
      ]),
    ).toThrow(/重复/);
  });

  it("从展示用时间抽出年份", () => {
    expect(parsePeriod("2023.03 - 2024.01")).toEqual({ startYear: 2023, endYear: 2024 });
    expect(parsePeriod("2024.06 - 至今")).toEqual({ startYear: 2024, endYear: 9999 });
    expect(parsePeriod("")).toEqual({ startYear: 0, endYear: 9999 });
  });

  it("解析 Markdown frontmatter", () => {
    const entry = parseMarkdownEntry(`---
id: proj-md
type: project
title: 纸上的项目
period: 2023.01 - 2023.12
tech_stack:
  - React
  - Node.js
---

这是正文。
`);
    expect(chunkEntries([entry])[0]).toMatchObject({
      id: "proj-md",
      type: "project",
      title: "纸上的项目",
      tech_stack: ["React", "Node.js"],
      text: "这是正文。",
    });
  });

  it("读取目录时跳过 samples，并合并 Markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-src-"));
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({
        example: true,
        name: "测试",
        headline: "一句话",
        skills: ["React"],
        contact: { email: "a@example.com" },
        resumePdf: "/resume/example.pdf",
        resumePdfFilename: "a.pdf",
      }),
    );
    writeFileSync(
      join(dir, "entries.json"),
      JSON.stringify({
        entries: [{ id: "edu-a", type: "education", title: "学校", period: "2018 - 2022", text: "教育" }],
      }),
    );
    mkdirSync(join(dir, "samples"));
    writeFileSync(join(dir, "samples", "skip.md"), "---\nid: skip\ntype: project\ntitle: 跳过\n---\n不要入库");
    writeFileSync(
      join(dir, "extra.md"),
      "---\nid: proj-md\ntype: project\ntitle: 额外项目\nperiod: 2024\ntech_stack:\n  - React\n---\n额外正文",
    );
    const loaded = loadResumeDirectory(dir);
    expect(loaded.profile.name).toBe("测试");
    expect(loaded.chunks.map((chunk) => chunk.id).sort()).toEqual(["edu-a", "proj-md"]);
  });
});
