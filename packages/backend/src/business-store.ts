import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Pool } from "pg";
import { plaintextClientIp } from "./abuse-protection.js";
import {
  feedbackSource,
  projectMessages,
  type PublicMessage,
  type StoredRow,
  type UiDetails,
} from "./transcript.js";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionSummary {
  messages: PublicMessage[];
}

export interface LoadedSession {
  id: string;
  title: string;
  rows: StoredRow[];
}

export interface FeedbackDraft {
  visitorId: string;
  sessionId: string;
  messageId: string;
  rating: "like" | "dislike";
  reason: string;
  comment: string;
}

export interface DislikeReport {
  createdAt: string;
  question: string;
  reason: string;
  chunkIds: string[];
}

export interface BusinessStore {
  ensureVisitor(cookieId: string | null): Promise<string>;
  createSession(visitorId: string, clientIp?: string | null): Promise<SessionSummary>;
  renameSession(visitorId: string, sessionId: string, title: string): Promise<SessionSummary | null>;
  /** 直接删掉会话。消息和反馈随外键级联删除，没有回收站。不属于该访客时返回 false。 */
  deleteSession(visitorId: string, sessionId: string): Promise<boolean>;
  clearFeedback(visitorId: string, sessionId: string, messageId: string): Promise<void>;
  listSessions(visitorId: string, query: string): Promise<SessionSummary[]>;
  getSession(visitorId: string, sessionId: string): Promise<SessionDetail | null>;
  loadSession(visitorId: string, sessionId: string): Promise<LoadedSession | null>;
  saveTranscript(input: { visitorId: string; sessionId: string; rows: StoredRow[]; title: string }): Promise<void>;
  insertFeedback(draft: FeedbackDraft): Promise<void>;
  recentDislikes(limit: number): Promise<DislikeReport[]>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MessageDbRow {
  id: string;
  seq: number;
  format_version: string;
  agent_message: AgentMessage;
  ui_details: UiDetails | null;
}

interface SessionDbRow {
  id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function toStored(row: MessageDbRow): StoredRow {
  return {
    id: row.id,
    seq: row.seq,
    formatVersion: row.format_version,
    agentMessage: row.agent_message,
    uiDetails: row.ui_details,
  };
}

async function loadRows(pool: Pool, sessionId: string): Promise<StoredRow[]> {
  const result = await pool.query<MessageDbRow>(
    `SELECT id, seq, format_version, agent_message, ui_details
     FROM messages
     WHERE session_id = $1
     ORDER BY seq ASC`,
    [sessionId],
  );
  return result.rows.map(toStored);
}

async function loadRatings(pool: Pool, sessionId: string): Promise<Map<string, "like" | "dislike">> {
  const result = await pool.query<{ message_id: string; rating: "like" | "dislike" }>(
    `SELECT DISTINCT ON (message_id) message_id, rating
     FROM feedback
     WHERE session_id = $1
     ORDER BY message_id, created_at DESC`,
    [sessionId],
  );
  return new Map(result.rows.map((row) => [row.message_id, row.rating]));
}

export function createPostgresBusinessStore(pool: Pool): BusinessStore {
  return {
    async ensureVisitor(cookieId: string | null): Promise<string> {
      if (cookieId && UUID_PATTERN.test(cookieId)) {
        const existing = await pool.query<{ id: string }>("SELECT id FROM visitors WHERE id = $1", [cookieId]);
        if (existing.rows[0]) return existing.rows[0].id;
      }
      const id = randomUUID();
      await pool.query("INSERT INTO visitors (id) VALUES ($1)", [id]);
      return id;
    },

    async createSession(visitorId: string, clientIp?: string | null): Promise<SessionSummary> {
      const id = randomUUID();
      const result = await pool.query<SessionDbRow>(
        `INSERT INTO sessions (id, visitor_id, client_ip) VALUES ($1, $2, $3)
         RETURNING id, title, created_at, updated_at`,
        [id, visitorId, plaintextClientIp(clientIp)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("没有创建会话");
      return { id: row.id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
    },

    async renameSession(visitorId: string, sessionId: string, title: string): Promise<SessionSummary | null> {
      if (!UUID_PATTERN.test(sessionId)) return null;
      const result = await pool.query<SessionDbRow>(
        `UPDATE sessions SET title = $3, updated_at = now()
         WHERE id = $1 AND visitor_id = $2
         RETURNING id, title, created_at, updated_at`,
        [sessionId, visitorId, title],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { id: row.id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
    },

    async deleteSession(visitorId: string, sessionId: string): Promise<boolean> {
      if (!UUID_PATTERN.test(sessionId)) return false;
      const result = await pool.query("DELETE FROM sessions WHERE id = $1 AND visitor_id = $2", [sessionId, visitorId]);
      return (result.rowCount ?? 0) > 0;
    },

    async listSessions(visitorId: string, query: string): Promise<SessionSummary[]> {
      const trimmed = query.trim();
      const result = await pool.query<SessionDbRow>(
        `SELECT s.id, s.title, s.created_at, s.updated_at
         FROM sessions s
         WHERE s.visitor_id = $1
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
           AND (
             $2::text = ''
             OR s.title ILIKE $3 ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM messages m
               WHERE m.session_id = s.id
                 AND m.agent_message->>'role' IN ('user', 'assistant')
                 AND m.agent_message::text ILIKE $3 ESCAPE '\\'
             )
           )
         ORDER BY s.updated_at DESC
         LIMIT 100`,
        [visitorId, trimmed, trimmed ? likePattern(trimmed) : "%"],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      }));
    },

    async getSession(visitorId: string, sessionId: string): Promise<SessionDetail | null> {
      const loaded = await this.loadSession(visitorId, sessionId);
      if (!loaded) return null;
      const ratings = await loadRatings(pool, sessionId);
      const summary = await pool.query<SessionDbRow>(
        `SELECT id, title, created_at, updated_at FROM sessions WHERE id = $1 AND visitor_id = $2`,
        [sessionId, visitorId],
      );
      const row = summary.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        messages: projectMessages(loaded.rows, ratings),
      };
    },

    async loadSession(visitorId: string, sessionId: string): Promise<LoadedSession | null> {
      if (!UUID_PATTERN.test(sessionId)) return null;
      const found = await pool.query<{ id: string; title: string }>(
        "SELECT id, title FROM sessions WHERE id = $1 AND visitor_id = $2",
        [sessionId, visitorId],
      );
      const session = found.rows[0];
      if (!session) return null;
      return { id: session.id, title: session.title, rows: await loadRows(pool, session.id) };
    },

    async saveTranscript(input: { visitorId: string; sessionId: string; rows: StoredRow[]; title: string }): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const owned = await client.query("SELECT id FROM sessions WHERE id = $1 AND visitor_id = $2", [
          input.sessionId,
          input.visitorId,
        ]);
        if (!owned.rows[0]) throw new Error("会话不存在");
        const ids = input.rows.map((row) => row.id);
        // 先删掉这一轮丢掉的消息（错误回答、重新生成的尾巴）。评分外键会跟着级联删掉。
        // 留下来的行不能先删再插，否则 ON DELETE CASCADE 会把已经记下的评分清掉。
        await client.query(
          `DELETE FROM messages WHERE session_id = $1 AND NOT (id = ANY($2::uuid[]))`,
          [input.sessionId, ids],
        );
        await client.query("UPDATE messages SET seq = -1 - seq WHERE session_id = $1", [input.sessionId]);
        for (const row of input.rows) {
          await client.query(
            `INSERT INTO messages (id, session_id, seq, format_version, agent_message, ui_details)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
             ON CONFLICT (id) DO UPDATE SET
               seq = EXCLUDED.seq,
               format_version = EXCLUDED.format_version,
               agent_message = EXCLUDED.agent_message,
               ui_details = EXCLUDED.ui_details`,
            [
              row.id,
              input.sessionId,
              row.seq,
              row.formatVersion,
              JSON.stringify(row.agentMessage),
              row.uiDetails ? JSON.stringify(row.uiDetails) : null,
            ],
          );
        }
        await client.query("UPDATE sessions SET title = $2, updated_at = now() WHERE id = $1", [
          input.sessionId,
          input.title,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async insertFeedback(draft: FeedbackDraft): Promise<void> {
      const loaded = await this.loadSession(draft.visitorId, draft.sessionId);
      if (!loaded) throw new FeedbackError("没有找到这轮对话。", 404);
      const source = feedbackSource(loaded.rows, draft.messageId);
      if (!source) throw new FeedbackError("没有找到这条回答。", 404);
      await pool.query(
        `INSERT INTO feedback (
           id, visitor_id, session_id, message_id, rating, reason, comment,
           question, answer, chunk_ids, model_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11)`,
        [
          randomUUID(),
          draft.visitorId,
          draft.sessionId,
          draft.messageId,
          draft.rating,
          draft.reason,
          draft.comment,
          source.question,
          source.answer,
          source.chunkIds,
          source.modelId,
        ],
      );
    },

    async clearFeedback(visitorId: string, sessionId: string, messageId: string): Promise<void> {
      const loaded = await this.loadSession(visitorId, sessionId);
      if (!loaded) throw new FeedbackError("没有找到这轮对话。", 404);
      const target = loaded.rows.find((row) => row.id === messageId);
      if (!target || target.agentMessage.role !== "assistant") throw new FeedbackError("没有找到这条回答。", 404);
      await pool.query("DELETE FROM feedback WHERE visitor_id = $1 AND session_id = $2 AND message_id = $3", [
        visitorId,
        sessionId,
        messageId,
      ]);
    },

    async recentDislikes(limit: number): Promise<DislikeReport[]> {
      const result = await pool.query<{
        created_at: Date | string;
        question: string;
        reason: string;
        chunk_ids: string[];
      }>(
        `SELECT created_at, question, reason, chunk_ids
         FROM feedback
         WHERE rating = 'dislike'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        createdAt: iso(row.created_at),
        question: row.question,
        reason: row.reason,
        chunkIds: row.chunk_ids ?? [],
      }));
    },
  };
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
