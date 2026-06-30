-- ── Event Reminders Table ─────────────────────────────────────────────────────
-- Stores scheduled Telegram notifications for event registrants.
-- Rows are inserted when a user joins an event.
-- The Edge Function `send-event-reminders` runs every 5 minutes via pg_cron
-- and sends due notifications, then marks them as sent.

CREATE TABLE IF NOT EXISTS event_reminders (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         text        NOT NULL,
  username         text        NOT NULL,
  telegram_chat_id text        NOT NULL,
  event_title      text        NOT NULL,
  event_date       date        NOT NULL,
  event_time       text,                          -- 'HH:MM' format, nullable
  event_link       text,                          -- Zoom / video link, nullable
  reminder_type    text        NOT NULL CHECK (reminder_type IN ('h1', 'h3', 'h30')),
  scheduled_at     timestamptz NOT NULL,
  sent_at          timestamptz,
  send_status      text,                          -- 'sent' | 'failed'
  created_at       timestamptz DEFAULT now()
);

-- Unique constraint prevents duplicate reminders if user re-registers
CREATE UNIQUE INDEX IF NOT EXISTS event_reminders_unique
  ON event_reminders (event_id, username, reminder_type);

-- Index for efficient polling by the Edge Function
CREATE INDEX IF NOT EXISTS event_reminders_due_idx
  ON event_reminders (scheduled_at)
  WHERE sent_at IS NULL;

-- RLS: allow service role full access, anon/user can insert their own rows
ALTER TABLE event_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON event_reminders
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "users can insert own reminders" ON event_reminders
  FOR INSERT WITH CHECK (true);


-- ── pg_cron: run Edge Function every 5 minutes ────────────────────────────────
-- Prerequisites:
--   1. Enable pg_cron extension in Supabase Dashboard → Database → Extensions
--   2. Enable pg_net extension (for HTTP calls from SQL)
--   3. Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> with your actual values
--
-- Run this block AFTER enabling both extensions:

/*
SELECT cron.schedule(
  'send-event-reminders',       -- job name
  '*/5 * * * *',                -- every 5 minutes
  $$
    SELECT net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-event-reminders',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
      ),
      body    := '{}'::jsonb
    );
  $$
);
*/
