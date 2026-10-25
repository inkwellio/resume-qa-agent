-- Up Migration
-- 首次接受提问时创建；永久保留，不能按日或按租约过期清理。
CREATE TABLE ip_chat_windows (
  ip_hash text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

-- Down Migration
DROP TABLE ip_chat_windows;
