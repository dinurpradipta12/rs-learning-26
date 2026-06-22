-- Add perks JSONB column to user_profiles
-- Run this in Supabase SQL Editor

alter table public.user_profiles
  add column if not exists perks jsonb not null default '{}';

-- Example perks structure:
-- {
--   "credit_exempt": true,       -- bypass ALL credit deductions
--   "free_video": true,          -- free video learning
--   "free_thread": true,         -- free post thread / discussion
--   "free_booking": true         -- free 1:1 booking
-- }
