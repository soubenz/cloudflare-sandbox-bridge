ALTER TABLE sessions ADD COLUMN cost_usd REAL;
ALTER TABLE sessions ADD COLUMN llm_usd REAL;
ALTER TABLE sessions ADD COLUMN running_s INTEGER;

-- more product tables are appended below by later migrations in this file
