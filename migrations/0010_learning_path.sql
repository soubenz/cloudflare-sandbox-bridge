-- The personal learning path (docs/api.md, "Personal learning path").
--
-- `user_profile_inputs` is what the learner told us: a level per platform
-- area from the onboarding quiz, an optional goal in their own words, the
-- kind of goal, and how many hours a week they have. One row per user,
-- replaced whenever the console reports a quiz retake or an edit.
--
-- `user_paths` is the path built from those inputs: the lab order the
-- learner sees, with a one-line reason per lab. `input_hash` is the SHA-256 of
-- everything the path was built from (inputs, the labs allowed, what the
-- user has completed, the plan, the model), so the same hash means the same
-- path and no model call is made. `source` says whether a model ordered it
-- ('ai') or the rules did, either because the model failed or timed out
-- ('rules'). `model` is the model id when source is 'ai', else NULL.
--
-- `goal_text` is free text the learner typed, so it is personal data: it
-- lives only in this row and is not copied into logs or analytics.
-- Timestamps are ms since epoch, like the rest of the schema.

CREATE TABLE IF NOT EXISTS user_profile_inputs (
  user_id TEXT PRIMARY KEY,
  areas_json TEXT NOT NULL,                                    -- {"gateway":"new","mcp":"strong",...}
  goal_text TEXT,                                              -- up to 200 characters, NULL when none
  goal_kind TEXT NOT NULL CHECK (goal_kind IN ('role-ready', 'specific-skill', 'explore')),
  hours_per_week INTEGER NOT NULL CHECK (hours_per_week BETWEEN 1 AND 20),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_paths (
  user_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  path_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai', 'rules')),
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
