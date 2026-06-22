CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id bigint PRIMARY KEY,
  step text NOT NULL,
  data jsonb DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);
