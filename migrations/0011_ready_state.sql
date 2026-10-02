-- Pre-warmed ("prepared") sessions park in a new state, `ready`: the container
-- is up but the lab has not begun. The one-active-session-per-user fence must
-- count it, or a user could hold a prepared session and a live one at once.
-- A partial index's predicate cannot be altered, so it is dropped and rebuilt
-- with the wider set. No row can be `ready` before this migration runs, so
-- the rebuilt unique index cannot find a violation.
DROP INDEX IF EXISTS sessions_active_user;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_user
  ON sessions(user_id)
  WHERE state IN ('starting', 'ready', 'running', 'recovering', 'resuming');
