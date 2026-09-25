-- `ip_hash` was populated only by POST /dev/sessions, which is gone: every
-- session now starts through an authenticated caller that knows who its
-- user is. The column keeps what it already holds and is written NULL from
-- here on, so the index over it is dead weight one day after landing.
--
-- The column itself stays. Dropping one in D1 is awkward, it costs nothing,
-- and the rows already written are the only record of which address started
-- those sessions.
DROP INDEX IF EXISTS sessions_active_ip;
