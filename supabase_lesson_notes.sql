CREATE TABLE IF NOT EXISTS lesson_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  lesson_key text NOT NULL,
  course_key text NOT NULL,
  content text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now(),
  UNIQUE (username, lesson_key)
);
