-- Up Migration
-- 全库只允许一个站长。密码是 bcrypt，会话只存 token 摘要。
CREATE TABLE admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^1[3-9][0-9]{9}$'),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_accounts_singleton ON admin_accounts ((true));

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY CHECK (char_length(token_hash) = 64),
  account_id uuid NOT NULL REFERENCES admin_accounts (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- Down Migration
DROP TABLE admin_sessions;
DROP TABLE admin_accounts;
