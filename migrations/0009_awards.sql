-- Awards a learner has earned (docs/api.md, "Profile, XP and awards").
--
-- One row per (user, award). The set of awards and the rule for each live in
-- code (src/profile/awards.ts); this table only remembers WHEN a learner first
-- qualified, so `earned_at` never moves once written and an award is never
-- taken back when a score later shifts. Inserts are `ON CONFLICT DO NOTHING`,
-- which is what makes recomputing idempotent.
--
-- `session_id` is the session whose check run triggered the award, or NULL when
-- it was backfilled by a profile read. Skill scores and XP are NOT stored: they
-- are recomputed from `check_runs` and `sessions` every time.

CREATE TABLE IF NOT EXISTS awards (
  user_id TEXT NOT NULL,
  award_id TEXT NOT NULL,
  earned_at INTEGER NOT NULL,                                 -- ms since epoch
  session_id TEXT,
  PRIMARY KEY (user_id, award_id)
);
