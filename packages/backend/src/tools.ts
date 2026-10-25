import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Profile, ResumeChunk, SearchQuery } from "@resume/retrieval";
import { Type, type TSchema } from "typebox";

function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool {
  return tool;
}

export interface ResumeLookup {
  search(query: SearchQuery, signal?: AbortSignal): Promise<ResumeChunk[]>;
  getById(id: string): Promise<ResumeChunk | null>;
  getProfile(): Profile;
}

const chunkType = Type.Union([
  Type.Literal("experience"),
  Type.Literal("project"),
  Type.Literal("skill"),
  Type.Literal("education"),
]);

function snippet(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function evidenceText(chunk: ResumeChunk): string {
  const stack = chunk.tech_stack.length ? `，技术栈：${chunk.tech_stack.join("、")}` : "";
  const period = chunk.period ? `（${chunk.period}）` : "";
  return `- [${chunk.type}] id=${chunk.id} ${chunk.title}${period}${stack}\n${chunk.text}`;
}

/** 每次检索只给最相关的几条，避免总评把整份简历倒出来。 */
export const SEARCH_RESULT_LIMIT = 4;
/** 同一轮聊天里继续检索的上限。档案接口不走这套工具实例。 */
export const MAX_SEARCH_CALLS_PER_TURN = 2;
export const MAX_PROJECT_DETAILS_PER_TURN = 2;

export function createResumeTools(lookup: ResumeLookup, options?: { perTurnLimits?: boolean }): AgentTool[] {
  const perTurnLimits = options?.perTurnLimits !== false;
  let searches = 0;
  let projectDetails = 0;
  const searchResume = defineTool({
    name: "search_resume",
    label: "正在查阅相关经历",
    description:
      "在简历里检索最相关的几条经历、项目、技能或教育背景。一次提问里最多调用两次；总评、这个人怎么样这类问题调用一次即可。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 512, pattern: "\\S", description: "检索词，例如技术、项目名或时间" }),
      type: Type.Optional(chunkType),
      tech_stack: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: "\\S", description: "可选，按一项技术过滤，例如 React" })),
      period_from: Type.Optional(Type.String({ pattern: "^[0-9]{4}$", description: "可选，只保留该年及之后仍相关的条目，例如 2023" })),
      period_to: Type.Optional(Type.String({ pattern: "^[0-9]{4}$", description: "可选，只保留该年及之前已经开始的条目，例如 2024" })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const periodFrom = params.period_from ? Number(params.period_from) : undefined;
      const periodTo = params.period_to ? Number(params.period_to) : undefined;
      if (params.period_from && !Number.isInteger(periodFrom)) {
        throw new Error("period_from 必须是年份");
      }
      if (params.period_to && !Number.isInteger(periodTo)) {
        throw new Error("period_to 必须是年份");
      }
      if (periodFrom !== undefined && periodTo !== undefined && periodFrom > periodTo) throw new Error("起始年份不能晚于结束年份");
      searches += 1;
      if (perTurnLimits && searches > MAX_SEARCH_CALLS_PER_TURN) {
        return {
          content: [
            {
              type: "text",
              text: "本轮检索已经够用。请根据前面查到的片段直接回答，不要再调用 search_resume，也不要为了总评把项目逐个打开。",
            },
          ],
          details: { kind: "search", items: [] },
        };
      }
      const hits = await lookup.search({
        query: params.query,
        limit: SEARCH_RESULT_LIMIT,
        ...(params.type ? { type: params.type } : {}),
        ...(params.tech_stack ? { techStack: params.tech_stack } : {}),
        ...(periodFrom !== undefined ? { periodFrom } : {}),
        ...(periodTo !== undefined ? { periodTo } : {}),
      }, signal);
      signal?.throwIfAborted();
      const content = hits.length
        ? `找到 ${hits.length} 条简历片段：\n${hits.map(evidenceText).join("\n")}\n这些是候选证据，只有正文直接支持问题时才能引用；缺少事实时请明确说明。`
        : `简历中没有检索到与「${params.query}」相关的内容。`;
      return {
        content: [{ type: "text", text: content }],
        details: {
          kind: "search",
          items: hits.map((chunk) => ({
            id: chunk.id,
            type: chunk.type,
            title: chunk.title,
            period: chunk.period,
            tech_stack: chunk.tech_stack,
            snippet: snippet(chunk.text),
          })),
        },
      };
    },
  });

  const getProjectDetail = defineTool({
    name: "get_project_detail",
    label: "正在查阅项目详情",
    description: "按 id 读取一个项目的全文，不做向量检索。id 来自 search_resume。只在对方追问这个项目时调用，不要把命中的项目逐个打开。",
    parameters: Type.Object({
      id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$", description: "项目 id，例如 proj-harbor" }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      projectDetails += 1;
      if (perTurnLimits && projectDetails > MAX_PROJECT_DETAILS_PER_TURN) {
        return {
          content: [
            {
              type: "text",
              text: "本轮项目详情已经够用。请根据已有内容回答，不要再调用 get_project_detail。",
            },
          ],
          details: { kind: "skipped" },
        };
      }
      const chunk = await lookup.getById(params.id);
      if (!chunk || chunk.type !== "project") {
        return {
          content: [{ type: "text", text: `简历中没有 id 为 ${params.id} 的项目。` }],
          details: { kind: "project_missing", id: params.id },
        };
      }
      const stack = chunk.tech_stack.length ? chunk.tech_stack.join("、") : "未写技术栈";
      return {
        content: [
          {
            type: "text",
            text: `项目：${chunk.title}\n时间：${chunk.period || "未写时间"}\n技术栈：${stack}\n${chunk.text}`,
          },
        ],
        details: {
          kind: "project",
          id: chunk.id,
          title: chunk.title,
          period: chunk.period,
          tech_stack: chunk.tech_stack,
          text: chunk.text,
        },
      };
    },
  });

  const downloadResume = defineTool({
    name: "download_resume",
    label: "正在获取简历文件",
    description: "返回简历 PDF 的下载地址。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const profile = lookup.getProfile();
      if (!profile.resumePdf) throw new Error("简历里没有 PDF 地址");
      if (!/^\/resume\/[^/?#]+\.pdf$/.test(profile.resumePdf) || /[\\/]/.test(decodeURIComponent(profile.resumePdf.slice(8)))) {
        throw new Error("简历下载地址必须指向本站的 PDF 文件");
      }
      return {
        content: [{ type: "text", text: `简历 PDF：${profile.resumePdf}` }],
        details: {
          kind: "download",
          url: profile.resumePdf,
          filename: profile.resumePdfFilename,
        },
      };
    },
  });

  const getContact = defineTool({
    name: "get_contact",
    label: "正在获取联系方式",
    description: "返回简历里写明的邮箱、电话和主页。没有的字段会空着，不要编造。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const contact = lookup.getProfile().contact;
      const lines = [
        contact.email ? `邮箱：${contact.email}` : "",
        contact.phone ? `电话：${contact.phone}` : "",
        contact.github ? `GitHub：${contact.github}` : "",
        contact.website ? `网站：${contact.website}` : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") || "简历里没有留下联系方式。" }],
        details: { kind: "contact", ...contact },
      };
    },
  });

  return [searchResume, getProjectDetail, downloadResume, getContact];
}

export function toolLabelMap(tools: AgentTool[]): Map<string, string> {
  return new Map(tools.map((tool) => [tool.name, tool.label]));
}

/** 步骤结束后换成完成态。进行中的文案仍用各工具自己的 label。 */
const DONE_LABEL: Record<string, string> = {
  search_resume: "已查阅相关经历",
  get_project_detail: "已获取项目详情",
  download_resume: "已获取简历文件",
  get_contact: "已获取联系方式",
};

export function doneToolLabel(name: string): string | undefined {
  return DONE_LABEL[name];
}
