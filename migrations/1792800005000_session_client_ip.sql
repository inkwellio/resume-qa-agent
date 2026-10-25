-- Up Migration
-- 新会话记下创建当时的客户端明文 IP，供站长列表和详情查看。旧行保持空。
ALTER TABLE sessions
  ADD COLUMN client_ip text;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_client_ip_len CHECK (client_ip IS NULL OR char_length(client_ip) BETWEEN 1 AND 64);

-- Down Migration
ALTER TABLE sessions DROP CONSTRAINT sessions_client_ip_len;
ALTER TABLE sessions DROP COLUMN client_ip;
