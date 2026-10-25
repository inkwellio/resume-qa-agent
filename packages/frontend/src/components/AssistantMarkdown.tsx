import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { stripThinkingTags } from "../visible-text";
import { safeAssistantHref } from "../assistant-links";

const remarkPlugins = [remarkGfm, remarkBreaks];

/**
 * 助手正文按 Markdown 渲染。不接入 rehype-raw，原文里的 HTML 只会当成文本，
 * 不会执行。可点击地址还需通过档案链接白名单，图片不渲染，避免自动外传。
 */
function components(allowedLinks: readonly string[]): Components {
  return {
    a({ href, title, children }) {
      const safeHref = safeAssistantHref(href, allowedLinks);
      if (!safeHref) return <>{children}</>;
      const external = /^https?:\/\//i.test(safeHref);
      return (
        <a href={safeHref} title={title} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {children}
        </a>
      );
    },
    // 远程 Markdown 图片会在展示回答时自动请求，不允许作为数据外传通道。
    img() { return null; },
    input({ type, checked }) {
      if (type !== "checkbox") return <input type={type} />;
      return <input type="checkbox" checked={Boolean(checked)} disabled />;
    },
    table({ children }) {
      return (
        <div className="assistant-md-table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

export function AssistantMarkdown({ text, footer, allowedLinks = [] }: { text: string; footer?: ReactNode; allowedLinks?: readonly string[] }) {
  const visible = stripThinkingTags(text);
  return (
    <div className="assistant-md">
      <Markdown remarkPlugins={remarkPlugins} components={components(allowedLinks)}>
        {visible}
      </Markdown>
      {footer}
    </div>
  );
}
