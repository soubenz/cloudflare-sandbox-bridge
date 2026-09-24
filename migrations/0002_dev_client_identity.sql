-- The dev-open session route derived a user's identity from their IP, so a
-- rotating address (any proxy, any mobile network, this project's own CI)
-- could not rejoin its session and started another container instead. Four
-- containers leaked in a single afternoon that way.
--
-- Identity now comes from a client-supplied id, which is stable across
-- address changes. The IP moves to its own column so it can still do the
-- job it was actually good at: capping how many containers one address can
-- hold at once. The unique index on user_id continues to fence one active
-- session per identity.
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;

CREATE INDEX IF NOT EXISTS sessions_active_ip
  ON sessions(ip_hash)
  WHERE state IN ('starting', 'running', 'recovering', 'resuming');
