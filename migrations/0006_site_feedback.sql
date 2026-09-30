-- Feedback sent from the public site's /feedback form (site/src/worker.ts).
-- Separate from the console's per-session `feedback` table (0005): this one
-- is anonymous, not tied to a session or a user. Email and message are
-- optional and are never logged by the Worker.
--
-- IF NOT EXISTS because two workflows apply migrations and either may
-- reach this one first.

CREATE TABLE IF NOT EXISTS feedback_site (
  id TEXT PRIMARY KEY,                                        -- random UUID
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  message TEXT,                                               -- optional, at most 2000 characters
  email TEXT,                                                 -- optional, normalised, lower-case
  country TEXT,                                               -- request.cf.country; no IP is stored
  source TEXT,                                                -- which link sent them, e.g. footer
  created_at INTEGER NOT NULL                                 -- ms since epoch
);

CREATE INDEX IF NOT EXISTS feedback_site_created ON feedback_site(created_at);
