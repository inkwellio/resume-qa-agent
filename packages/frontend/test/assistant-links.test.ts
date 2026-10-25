import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeAssistantHref } from "../src/assistant-links.ts";

describe("回答链接的来源限制", () => {
  const allowed = ["/resume/example.pdf", "https://github.com/example", "mailto:person@example.com", "tel:+8613800000000"];

  it("保留档案提供的下载、主页、邮件和电话链接", () => {
    for (const href of allowed) assert.equal(safeAssistantHref(href, allowed), href);
  });

  it("拒绝追踪地址、伪装域名、额外查询参数、任意本地路径和危险协议", () => {
    for (const href of [
      "https://example.invalid/collect?data=private", "https://github.com@example.invalid/",
      "https://github.com/example?data=private", "https://github.com/example.evil",
      "/api/sessions", "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//example.invalid/collect",
    ]) assert.equal(safeAssistantHref(href, allowed), undefined);
    assert.equal(safeAssistantHref("javascript:alert(1)", ["javascript:alert(1)"]), undefined);
    assert.equal(safeAssistantHref(undefined, allowed), undefined);
  });
});
