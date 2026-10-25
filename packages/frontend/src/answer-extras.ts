import type { Citation, ToolStep } from "./types";

/** 总评下面默认只露几条依据，其余折起来。 */
export const MAX_VISIBLE_CITATIONS = 3;

export interface ProjectCardData {
  id: string;
  title: string;
  period: string;
  tech_stack: string[];
}

export function titleMentioned(title: string, text: string): boolean {
  const haystack = text.replace(/\s+/g, "").toLowerCase();
  if (!haystack) return false;
  const full = title.replace(/\s+/g, "").trim().toLowerCase();
  if (full.length >= 2 && haystack.includes(full)) return true;
  const head = (title.split(/[|｜]/)[0] ?? "").replace(/\s+/g, "").trim().toLowerCase();
  return head.length >= 4 && head !== full && haystack.includes(head);
}

export function dedupedCitations(tools: ToolStep[]): Citation[] {
  const seen = new Set<string>();
  const items: Citation[] = [];
  for (const step of tools) {
    if (step.details?.kind !== "search") continue;
    for (const item of step.details.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** 正文点了名的条目优先。一个都没点到时，只留检索顺序里的前几条。 */
export function visibleCitations(tools: ToolStep[], text: string): { shown: Citation[]; hiddenCount: number } {
  const items = dedupedCitations(tools);
  const named = items.filter((item) => titleMentioned(item.title, text));
  const shown = (named.length > 0 ? named : items).slice(0, MAX_VISIBLE_CITATIONS);
  const shownIds = new Set(shown.map((item) => item.id));
  return {
    shown,
    hiddenCount: items.filter((item) => !shownIds.has(item.id)).length,
  };
}

/**
 * 项目卡只留给正文写到的项目，以及 get_project_detail 的结果。
 * 检索命中但回答没提的项目不铺出来。
 */
export function selectProjectCards(tools: ToolStep[], text: string): ProjectCardData[] {
  const cards = new Map<string, ProjectCardData>();
  const show = new Set<string>();
  const remember = (card: ProjectCardData) => {
    const prev = cards.get(card.id);
    if (!prev) {
      cards.set(card.id, card);
      return;
    }
    cards.set(card.id, {
      id: card.id,
      title: card.title || prev.title,
      period: card.period || prev.period,
      tech_stack: card.tech_stack.length > 0 ? card.tech_stack : prev.tech_stack,
    });
  };
  for (const step of tools) {
    const details = step.details;
    if (!details) continue;
    if (details.kind === "search") {
      for (const item of details.items) {
        if (item.type !== "project") continue;
        remember({ id: item.id, title: item.title, period: item.period, tech_stack: item.tech_stack });
        if (titleMentioned(item.title, text)) show.add(item.id);
      }
      continue;
    }
    if (details.kind === "project") {
      remember({
        id: details.id,
        title: details.title,
        period: details.period,
        tech_stack: details.tech_stack,
      });
      show.add(details.id);
    }
  }
  const ordered: ProjectCardData[] = [];
  for (const [id, card] of cards) {
    if (show.has(id)) ordered.push(card);
  }
  return ordered;
}
