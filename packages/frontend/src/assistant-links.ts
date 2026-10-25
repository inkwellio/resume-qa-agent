/** 只允许主人档案中配置的链接；不让回答构造带对话内容的外部地址。 */
export function safeAssistantHref(href: string | undefined, allowedLinks: readonly string[]): string | undefined {
  if (!href) return undefined;
  const base = "https://resume.invalid";
  try {
    const candidate = new URL(href, base);
    if (!["https:", "http:", "mailto:", "tel:"].includes(candidate.protocol) || candidate.username || candidate.password) return undefined;
    for (const approved of allowedLinks) {
      if (!approved) continue;
      try {
        const target = new URL(approved, base);
        if (candidate.href === target.href) return approved;
      } catch { /* 忽略格式错误的档案链接。 */ }
    }
  } catch { /* 不把无效链接渲染为可点击地址。 */ }
  return undefined;
}
