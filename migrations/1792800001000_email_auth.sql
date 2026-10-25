-- Up Migration
ALTER TABLE users ADD COLUMN email text UNIQUE;
CREATE UNIQUE INDEX visitors_user_unique ON visitors (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE email_login_codes (
  email_key text PRIMARY KEY,
  generation uuid NOT NULL,
  code_hash text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  ready boolean NOT NULL DEFAULT false
);
CREATE INDEX email_login_codes_sent_at_idx ON email_login_codes (sent_at);

CREATE TABLE email_auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX email_auth_sessions_expires_idx ON email_auth_sessions (expires_at);

-- Down Migration
DROP TABLE email_auth_sessions;
DROP TABLE email_login_codes;
DROP INDEX visitors_user_unique;
ALTER TABLE users DROP COLUMN email;
