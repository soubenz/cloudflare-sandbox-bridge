-- The public site's waitlist (site/src/worker.ts). Nothing in the sandbox
-- API reads or writes this table; it lives in this database only so the
-- site needs no infrastructure of its own. The future admin panel reads it.
--
-- IF NOT EXISTS because two workflows apply migrations (Deploy and Deploy
-- site) and either may reach this one first.

CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,           -- normalised, lower-case
  plan TEXT NOT NULL CHECK (plan IN ('individual', 'team')),
  role TEXT,                        -- optional, from the form's fixed list
  country TEXT,                     -- request.cf.country; no IP is stored
  source TEXT,                      -- which call to action, e.g. hero, pricing
  created_at INTEGER NOT NULL,      -- first signup, ms since epoch
  updated_at INTEGER NOT NULL       -- last resubmission
);

CREATE INDEX IF NOT EXISTS waitlist_created ON waitlist(created_at);
