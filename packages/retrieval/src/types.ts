/** 简历片段类型。一条经历、一个项目、一组技能或一条教育经历各成一块。 */
export const CHUNK_TYPES = ["experience", "project", "skill", "education"] as const;

export type ChunkType = (typeof CHUNK_TYPES)[number];

export interface ResumeChunk {
  id: string;
  type: ChunkType;
  title: string;
  period: string;
  tech_stack: string[];
  text: string;
}

/** 主人编辑的原始条目。Markdown frontmatter 和 JSON 都先变成这个形状。 */
export interface RawEntry {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  period?: unknown;
  tech_stack?: unknown;
  text?: unknown;
}

export interface ContactInfo {
  email: string;
  phone: string;
  github: string;
  website: string;
}

/** 档案卡片的数据，直接来自 profile.json，不经过向量检索。 */
export interface Profile {
  /** 为 true 时页面会标出「示例数据」。换成真实简历后请设为 false。 */
  example: boolean;
  name: string;
  headline: string;
  avatar: string;
  skills: string[];
  contact: ContactInfo;
  /** 浏览器可访问的 PDF 路径，例如 /resume/example.pdf。 */
  resumePdf: string;
  resumePdfFilename: string;
}

export interface SearchQuery {
  query: string;
  type?: ChunkType;
  techStack?: string;
  /** 只保留结束年份不早于该年的片段（含「至今」）。 */
  periodFrom?: number;
  /** 只保留开始年份不晚于该年的片段。 */
  periodTo?: number;
  limit?: number;
}

export interface EmbeddingClient {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
