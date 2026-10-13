-- Where a learner is in a lab's pre-lab flow ("Before you begin") or in a
-- warm-up, so closing the tab, or opening the console on another browser or
-- device, does not lose their place (docs/learning-content.md, "Saving
-- progress"; routes in docs/api.md).
--
-- One row per user per lab, replaced on every save. `version` is the lab's
-- learn bundle version the state was planned against: the console starts over
-- when it no longer matches. `state_json` is the flow's own record (the steps,
-- the step on screen, the answers given, the lesson pages, the games played),
-- validated and capped at 32 KiB by PUT /users/:uid/labs/:slug/learn-progress.
-- The row is deleted when the learner starts over, when the lab is started,
-- and when the warm-up is finished.

CREATE TABLE IF NOT EXISTS learn_progress (
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,                                -- ms since epoch
  PRIMARY KEY (user_id, slug)
);
