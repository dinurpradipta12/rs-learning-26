-- Add answered flag to forum_replies for QNA Session threads
ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS answered boolean NOT NULL DEFAULT false;
