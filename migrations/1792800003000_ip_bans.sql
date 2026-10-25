-- Up Migration
-- 站长手动封禁。ip_hash 与防刷表一致。
-- 不从请求自动记录原始 IP；ip_display 只在站长于后台输入地址时写入。
CREATE TABLE ip_bans (
  ip_hash text PRIMARY KEY,
  ip_display text NOT NULL CHECK (char_length(ip_display) BETWEEN 1 AND 64),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS ip_bans;
