export interface Profile {
  example: boolean;
  name: string;
  headline: string;
  avatar: string;
  skills: string[];
  contact: {
    email: string;
    phone: string;
    github: string;
    website: string;
  };
  resumePdf: string;
  resumePdfFilename: string;
}

export type ChunkType = "experience" | "project" | "skill" | "education";

export interface Citation {
  id: string;
  type: ChunkType;
  title: string;
  period: string;
  tech_stack: string[];
  snippet: string;
}

export interface ProjectDetail {
  kind: "project";
  id: string;
  title: string;
  period: string;
  tech_stack: string[];
  text: string;
}

export type ToolDetails =
  | { kind: "search"; items: Citation[] }
  | ProjectDetail
  | { kind: "project_missing"; id: string }
  | { kind: "download"; url: string; filename: string }
  | {
      kind: "contact";
      email: string;
      phone: string;
      github: string;
      website: string;
    };

export type ToolStatus = "pending" | "success" | "error";

export interface ToolStep {
  toolCallId: string;
  name: string;
  label: string;
  status: ToolStatus;
  args?: unknown;
  content?: string;
  details?: ToolDetails;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  tools?: ToolStep[];
  error?: string;
  /** 服务端已经把这条回答写入数据库，反馈和重新生成才可用。 */
  saved?: boolean;
  rating?: "like" | "dislike" | null;
  /** 用户中途停止。重新打开会话时仍在。 */
  stopped?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
