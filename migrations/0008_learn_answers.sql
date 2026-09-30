-- Anonymous answer analytics for the learning layer (docs/learning-content.md).
--
-- One row per answered quiz question, so an author can see which questions
-- are too easy, too hard or misleading. Deliberately NOT personal data: there
-- is no user id, no session id and no IP address on this table, and the
-- write route (POST /learn/answers) rejects a body that tries to send one. A
-- row cannot be tied back to a learner, so it needs no erasure handling.
--
-- `lab_slug` / `lab_version` are NULL for the platform onboarding quiz, which
-- belongs to no lab. `phase` says which quiz the answer came from.

CREATE TABLE IF NOT EXISTS learn_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_slug TEXT,
  lab_version TEXT,
  question_id TEXT NOT NULL,
  concept TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  phase TEXT NOT NULL CHECK (phase IN ('onboarding', 'diagnostic')),
  created_at INTEGER NOT NULL                                 -- ms since epoch
);

CREATE INDEX IF NOT EXISTS learn_answers_question ON learn_answers(lab_slug, question_id);
CREATE INDEX IF NOT EXISTS learn_answers_created ON learn_answers(created_at);
