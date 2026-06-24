-- 026: Initial habit_triggers seed
-- 2026-05-17
--
-- Background: hooks/cli.ts has a habit detector that JOINs habit_triggers
-- to good_habits / bad_habits to decide whether a tool invocation should
-- fire a habit prompt. 25 good_habits + 13 bad_habits existed but
-- habit_triggers was empty — every detection returned 0 rows. Dead
-- read path caught by _audit-empty-tables-classify cross-DB extension.
--
-- This migration seeds 10 trigger mappings for the most actionable habits.
-- Detector has 10-minute cooldown so even hot tools fire <= 6/hour.

INSERT INTO habit_triggers (habit_type, habit_id, trigger_type, trigger_value) VALUES
  ('good', 3,  'tool',    'Read'),
  ('good', 4,  'keyword', 'phpunit|jest|vitest|pytest|npm test|artisan test'),
  ('good', 5,  'tool',    'Glob'),
  ('good', 5,  'tool',    'Grep'),
  ('good', 12, 'keyword', 'curl|playwright|smoke.test'),
  ('bad',  1,  'tool',    'Edit'),
  ('bad',  1,  'tool',    'Write'),
  ('bad',  5,  'keyword', 'sqlite3|php artisan tinker --execute'),
  ('bad',  8,  'keyword', '^I will|^Let me first|^Going to'),
  ('bad',  9,  'keyword', '^Now |^Next |^I am about to')
ON CONFLICT DO NOTHING;
