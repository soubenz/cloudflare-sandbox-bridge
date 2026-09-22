-- Index tables only. Source of truth for a live session is its Session DO;
-- these tables exist for cross-session queries the app needs (one-active-
-- session-per-user, a user's history, lab pass/fail stats).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  lab_slug TEXT NOT NULL,
  lab_version TEXT NOT NULL,
  family TEXT NOT NULL,
  state TEXT NOT NULL,
  sandbox_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  expires_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  resumed_count INTEGER NOT NULL DEFAULT 0
);

-- One active (starting|running) session per user. This is the enforcement
-- point for the product plan's "one session per user at a time" fence.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_user
  ON sessions(user_id)
  WHERE state IN ('starting', 'running', 'recovering', 'resuming');

CREATE INDEX IF NOT EXISTS sessions_user_created ON sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_lab ON sessions(lab_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  lab_slug TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  name TEXT,
  ttl_s INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_session ON snapshots(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_user ON snapshots(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  passed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  results_json TEXT
);

CREATE INDEX IF NOT EXISTS check_runs_session ON check_runs(session_id, started_at DESC);
