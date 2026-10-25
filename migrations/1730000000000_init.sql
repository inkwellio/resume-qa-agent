-- Up Migration
-- 业务数据和简历向量放在同一个库。vector(1024) 对应默认的 BAAI/bge-m3。
-- 换 embedding 模型如果维度变了，要另写迁移改这一列，再重新 pnpm ingest。

CREATE EXTENSION IF NOT EXISTS vector;

-- 登录还没做。users 先占着，visitors.user_id 以后挂到这里。
CREATE TABLE users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visitors (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES visitors (id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_visitor_updated_idx ON sessions (visitor_id, updated_at DESC);

-- agent_message 原样保存 pi-agent-core 的 AgentMessage（含工具调用和工具结果）。
-- format_version 记下当时的 agent-core 版本，升级时用它做迁移。
-- ui_details 只给界面重画卡片，不参与模型上下文的拼装。
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  format_version text NOT NULL,
  agent_message jsonb NOT NULL,
  ui_details jsonb,
  UNIQUE (session_id, seq)
);

CREATE TABLE feedback (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES visitors (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('like', 'dislike')),
  reason text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  question text NOT NULL,
  answer text NOT NULL,
  chunk_ids text[] NOT NULL DEFAULT '{}',
  model_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_created_at_idx ON feedback (created_at DESC);

-- 片段 id 来自简历原文，重建时沿用，不在库里重新生成。
-- search_tokens 是结巴分好的词，simple 配置不再做英文词干，避免中文被拆坏。
CREATE TABLE resume_chunks (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('experience', 'project', 'skill', 'education')),
  title text NOT NULL,
  period text NOT NULL DEFAULT '',
  tech_stack text[] NOT NULL DEFAULT '{}',
  text text NOT NULL,
  start_year integer NOT NULL,
  end_year integer NOT NULL,
  search_tokens text NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_tokens)) STORED,
  embedding vector(1024) NOT NULL
);

CREATE INDEX resume_chunks_search_tsv_idx ON resume_chunks USING gin (search_tsv);

CREATE INDEX resume_chunks_embedding_hnsw
  ON resume_chunks USING hnsw (embedding vector_cosine_ops);

-- Down Migration

DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS visitors;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS resume_chunks;
