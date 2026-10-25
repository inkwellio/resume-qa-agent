import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Pool } from "pg";
import { visibleTurns, type StoredRow, type UiDetails } from "./transcript.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AdminUser {
  userId: string;
  email: string;
  createdAt: string;
  visitorCount: number;
  sessionCount: number;
  lastSessionAt: string | null;
}

export interface AdminSessionSummary {
  id: string;
  title: string;
  visitorId: string;
  userId: string | null;
  email: string | null;
  ip: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSessionDetail extends AdminSessionSummary {
  turns: Array<{ question: string; answer: string }>;
}

export interface AdminPage {
  limit: number;
  offset: number;
}

export interface AdminDirectory {
  listUsers(page: AdminPage): Promise<{ users: AdminUser[]; total: number }>;
  listSessions(query: { userId: string | null; visitorId: string | null } & AdminPage): Promise<{ sessions: AdminSessionSummary[]; total: number }>;
  getSession(sessionId: string): Promise<AdminSessionDetail | null>;
}

export function createEmptyAdminDirectory(): AdminDirectory {
  return {
    async listUsers() { return { users: [], total: 0 }; },
    async listSessions() { return { sessions: [], total: 0 }; },
    async getSession() { return null; },
  };
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface UserDbRow {
  id: string;
  email: string;
  created_at: Date | string;
  visitor_count: number | string;
  session_count: number | string;
  last_session_at: Date | string | null;
}

interface SessionDbRow {
  id: string;
  title: string;
  visitor_id: string;
  user_id: string | null;
  email: string | null;
  client_ip: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toSummary(row: SessionDbRow): AdminSessionSummary {
  return {
    id: row.id,
    title: row.title,
    visitorId: row.visitor_id,
    userId: row.user_id,
    email: row.email,
    ip: row.client_ip,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export function createPostgresAdminDirectory(pool: Pool): AdminDirectory {
  return {
    async listUsers(page) {
      const total = await pool.query<{ total: number | string }>(
        `SELECT count(*)::int AS total FROM users WHERE email IS NOT NULL AND btrim(email) <> ''`,
      );
      const result = await pool.query<UserDbRow>(
        `SELECT u.id, u.email, u.created_at,
                COUNT(DISTINCT v.id)::int AS visitor_count,
                COUNT(DISTINCT s.id)::int AS session_count,
                MAX(s.updated_at) AS last_session_at
         FROM users u
         LEFT JOIN visitors v ON v.user_id = u.id
         LEFT JOIN sessions s ON s.visitor_id = v.id
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         WHERE u.email IS NOT NULL AND btrim(u.email) <> ''
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        [page.limit, page.offset],
      );
      return {
        total: count(total.rows[0]?.total),
        users: result.rows.map((row) => ({
          userId: row.id,
          email: row.email,
          createdAt: iso(row.created_at) ?? "",
          visitorCount: count(row.visitor_count),
          sessionCount: count(row.session_count),
          lastSessionAt: iso(row.last_session_at),
        })),
      };
    },
    async listSessions(query) {
      const filters = [query.userId, query.visitorId];
      const total = await pool.query<{ total: number | string }>(
        `SELECT count(*)::int AS total
         FROM sessions s
         JOIN visitors v ON v.id = s.visitor_id
         LEFT JOIN users u ON u.id = v.user_id
         WHERE ($1::uuid IS NULL OR u.id = $1::uuid)
           AND ($2::uuid IS NULL OR v.id = $2::uuid)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`,
        filters,
      );
      const result = await pool.query<SessionDbRow>(
        `SELECT s.id, s.title, s.visitor_id, u.id AS user_id, u.email, s.client_ip, s.created_at, s.updated_at
         FROM sessions s
         JOIN visitors v ON v.id = s.visitor_id
         LEFT JOIN users u ON u.id = v.user_id
         WHERE ($1::uuid IS NULL OR u.id = $1::uuid)
           AND ($2::uuid IS NULL OR v.id = $2::uuid)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         ORDER BY s.updated_at DESC
         LIMIT $3 OFFSET $4`,
        [...filters, query.limit, query.offset],
      );
      return { total: count(total.rows[0]?.total), sessions: result.rows.map(toSummary) };
    },
    async getSession(sessionId) {
      if (!UUID.test(sessionId)) return null;
      const found = await pool.query<SessionDbRow>(
        `SELECT s.id, s.title, s.visitor_id, u.id AS user_id, u.email, s.client_ip, s.created_at, s.updated_at
         FROM sessions s
         JOIN visitors v ON v.id = s.visitor_id
         LEFT JOIN users u ON u.id = v.user_id
         WHERE s.id = $1`,
        [sessionId],
      );
      const session = found.rows[0];
      if (!session) return null;
      const messages = await pool.query<{
        id: string;
        seq: number;
        format_version: string;
        agent_message: AgentMessage;
        ui_details: UiDetails | null;
      }>(
        `SELECT id, seq, format_version, agent_message, ui_details
         FROM messages WHERE session_id = $1 ORDER BY seq ASC`,
        [sessionId],
      );
      const rows: StoredRow[] = messages.rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        formatVersion: row.format_version,
        agentMessage: row.agent_message,
        uiDetails: row.ui_details,
      }));
      return { ...toSummary(session), turns: visibleTurns(rows) };
    },
  };
}
