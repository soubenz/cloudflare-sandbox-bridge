-- Product tables and columns for progress, completion, feedback and plans.
-- Split out of 0005 (which had already been applied to production with only
-- the three cost columns): D1 tracks migrations by file name, so a file that
-- has run once never runs again -- new statements always go in a new file.

-- What a check run was worth, and who it belongs to, so progress can be
-- aggregated per user and lab without joining through sessions. `score` is the
-- weighted share of checks passed (0-1); `passed_all` is 1 when every check in
-- the lab passed in that run.
ALTER TABLE check_runs ADD COLUMN user_id TEXT;
ALTER TABLE check_runs ADD COLUMN lab_slug TEXT;
ALTER TABLE check_runs ADD COLUMN lab_version TEXT;
ALTER TABLE check_runs ADD COLUMN score REAL;
ALTER TABLE check_runs ADD COLUMN passed_all INTEGER;

CREATE INDEX IF NOT EXISTS check_runs_user_lab
  ON check_runs(user_id, lab_slug, started_at DESC);

-- `completed_at` is when a run first passed every check; `hints_delivered` is
-- how many hints had unlocked when the session ended.
ALTER TABLE sessions ADD COLUMN completed_at INTEGER;
ALTER TABLE sessions ADD COLUMN hints_delivered INTEGER;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  minutes_cap INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE,
  user_id TEXT,
  lab_slug TEXT,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  text TEXT,
  created_at INTEGER NOT NULL
);
