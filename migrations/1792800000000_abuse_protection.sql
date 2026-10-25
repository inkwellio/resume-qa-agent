-- Up Migration

-- 所有实例共享的请求窗口、每日请求计数和生成租约；不保存原始 IP。
CREATE TABLE request_rate_windows (
  scope text NOT NULL,
  identity_hash text NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  reset_at timestamptz NOT NULL,
  PRIMARY KEY (scope, identity_hash)
);
CREATE INDEX request_rate_windows_reset_idx ON request_rate_windows (reset_at);

CREATE TABLE chat_daily_usage (
  day date NOT NULL,
  scope text NOT NULL,
  identity_hash text NOT NULL,
  requests integer NOT NULL CHECK (requests > 0),
  PRIMARY KEY (day, scope, identity_hash)
);

CREATE TABLE active_chat_leases (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE,
  visitor_id uuid NOT NULL,
  ip_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  stop_requested boolean NOT NULL DEFAULT false
);
CREATE INDEX active_chat_leases_expiry_idx ON active_chat_leases (expires_at);

-- Down Migration
DROP TABLE IF EXISTS active_chat_leases;
DROP TABLE IF EXISTS chat_daily_usage;
DROP TABLE IF EXISTS request_rate_windows;
