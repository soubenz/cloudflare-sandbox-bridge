import type { Env } from '../env';
import type { CheckResultEntry } from './state';
import { ApiError } from '../lib/errors';

/**
 * Read side of the `check_runs` table: per-user progress per lab and the
 * history of individual runs. The SQL is built by small pure functions
 * (`*Query`) and the rows are shaped by pure parsers so both are unit
 * tested without a database; the async wrappers only run the statement.
 */

/** How a check run is scored: the weighted share of checks that passed, 0-1. */
export interface RunScore {
  passed: number;
  total: number;
  score: number;
  /** True when every check that ran passed and `expectedTotal`, if given, checks ran. */
  passed_all: boolean;
}

/**
 * `expectedTotal` is the number of checks the lab defines. A run limited
 * with `only` covers fewer, and passing that subset must not count as
 * finishing the lab.
 */
export function scoreRun(results: Pick<CheckResultEntry, 'pass' | 'weight'>[], expectedTotal?: number): RunScore {
  const passed = results.filter((r) => r.pass).length;
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const passedWeight = results.filter((r) => r.pass).reduce((sum, r) => sum + r.weight, 0);
  const complete = results.length > 0 && passed === results.length && (expectedTotal === undefined || results.length >= expectedTotal);
  return { passed, total: results.length, score: totalWeight > 0 ? passedWeight / totalWeight : 0, passed_all: complete };
}

// ---------------------------------------------------------------------------
// Limits

export const DEFAULT_CHECKS_LIMIT = 20;
export const MAX_CHECKS_LIMIT = 100;

/** A `limit` query value clamped to 1..MAX_CHECKS_LIMIT; anything unparseable gets the default. */
export function clampLimit(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHECKS_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHECKS_LIMIT;
  return Math.min(n, MAX_CHECKS_LIMIT);
}

// ---------------------------------------------------------------------------
// Progress per lab

export interface LabProgress {
  slug: string;
  attempts: number;
  best_score: number;
  passed_all: boolean;
  last_run_at: number | null;
  sessions: number;
}

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

interface ProgressRow {
  slug?: string | null;
  attempts?: number | null;
  best_score?: number | null;
  passed_all?: number | null;
  last_run_at?: number | null;
  sessions?: number | null;
}

const PROGRESS_AGGREGATES = `COUNT(*) AS attempts,
       MAX(score) AS best_score,
       MAX(passed_all) AS passed_all,
       MAX(started_at) AS last_run_at,
       COUNT(DISTINCT session_id) AS sessions`;

/** One row per lab the user has run checks for, most recently attempted first. */
export function userProgressQuery(userId: string): SqlQuery {
  return {
    sql: `SELECT lab_slug AS slug, ${PROGRESS_AGGREGATES}
     FROM check_runs
     WHERE user_id = ? AND lab_slug IS NOT NULL
     GROUP BY lab_slug
     ORDER BY last_run_at DESC`,
    params: [userId],
  };
}

export function parseProgressRow(row: ProgressRow, slug = row.slug ?? ''): LabProgress {
  return {
    slug,
    attempts: Number(row.attempts ?? 0),
    best_score: Number(row.best_score ?? 0),
    passed_all: Number(row.passed_all ?? 0) > 0,
    last_run_at: row.last_run_at ?? null,
    sessions: Number(row.sessions ?? 0),
  };
}

export async function userProgress(env: Env, userId: string): Promise<{ labs: LabProgress[] }> {
  const { sql, params } = userProgressQuery(userId);
  const result = await env.DB.prepare(sql).bind(...params).all<ProgressRow>();
  return { labs: (result.results ?? []).map((row) => parseProgressRow(row)) };
}

/** The user+lab aggregate, plus how many of those attempts were made in this session. */
export function progressSummaryQuery(sessionId: string, userId: string, labSlug: string): SqlQuery {
  return {
    sql: `SELECT ${PROGRESS_AGGREGATES},
       COALESCE(SUM(CASE WHEN session_id = ? THEN 1 ELSE 0 END), 0) AS attempts_this_session
     FROM check_runs
     WHERE user_id = ? AND lab_slug = ?`,
    params: [sessionId, userId, labSlug],
  };
}

export type ProgressSummary = LabProgress & { attempts_this_session: number };

export async function sessionProgressSummary(env: Env, sessionId: string, userId: string, labSlug: string): Promise<ProgressSummary> {
  const { sql, params } = progressSummaryQuery(sessionId, userId, labSlug);
  const row = await env.DB.prepare(sql).bind(...params).first<ProgressRow & { attempts_this_session?: number | null }>();
  return { ...parseProgressRow(row ?? {}, labSlug), attempts_this_session: Number(row?.attempts_this_session ?? 0) };
}

// ---------------------------------------------------------------------------
// Check run history

export interface CheckRunRecord {
  run_id: string;
  session_id?: string;
  lab_slug?: string | null;
  started_at: number;
  finished_at: number | null;
  passed: number;
  total: number;
  score: number | null;
  results: unknown[];
}

interface CheckRunRow {
  id: string;
  session_id?: string;
  lab_slug?: string | null;
  started_at: number;
  finished_at: number | null;
  passed: number;
  total: number;
  score?: number | null;
  results_json: string | null;
}

export function parseCheckRunRow(row: CheckRunRow, withOwner = false): CheckRunRecord {
  let results: unknown[] = [];
  try {
    const parsed = row.results_json ? JSON.parse(row.results_json) : [];
    if (Array.isArray(parsed)) results = parsed;
  } catch {
    // A row we cannot parse still counts as a run; only its detail is lost.
  }
  return {
    run_id: row.id,
    ...(withOwner ? { session_id: row.session_id, lab_slug: row.lab_slug ?? null } : {}),
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    passed: row.passed,
    total: row.total,
    score: row.score ?? null,
    results,
  };
}

const RUN_COLUMNS = 'id, session_id, lab_slug, started_at, finished_at, passed, total, score, results_json';

/** The last `limit` runs of one session, newest first. */
export function sessionChecksQuery(sessionId: string, limit: number): SqlQuery {
  return {
    sql: `SELECT ${RUN_COLUMNS} FROM check_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?`,
    params: [sessionId, clampLimit(limit)],
  };
}

export interface UserChecksFilter {
  lab?: string;
  limit?: number;
  /** Cursor: only runs that started strictly before this epoch-ms time. */
  before?: number;
}

/** A user's runs across sessions, newest first, optionally for one lab and/or before a cursor. */
export function userChecksQuery(userId: string, filter: UserChecksFilter = {}): SqlQuery {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (filter.lab) {
    where.push('lab_slug = ?');
    params.push(filter.lab);
  }
  if (filter.before !== undefined) {
    where.push('started_at < ?');
    params.push(filter.before);
  }
  params.push(clampLimit(filter.limit));
  return {
    sql: `SELECT ${RUN_COLUMNS} FROM check_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`,
    params,
  };
}

export async function sessionChecks(env: Env, sessionId: string, limit?: number): Promise<{ runs: CheckRunRecord[] }> {
  const { sql, params } = sessionChecksQuery(sessionId, clampLimit(limit));
  const result = await env.DB.prepare(sql).bind(...params).all<CheckRunRow>();
  return { runs: (result.results ?? []).map((r) => parseCheckRunRow(r)) };
}

export async function userChecks(env: Env, userId: string, filter: UserChecksFilter = {}): Promise<{ runs: CheckRunRecord[] }> {
  const { sql, params } = userChecksQuery(userId, filter);
  const result = await env.DB.prepare(sql).bind(...params).all<CheckRunRow>();
  return { runs: (result.results ?? []).map((r) => parseCheckRunRow(r, true)) };
}

// ---------------------------------------------------------------------------
// Feedback

export const MAX_FEEDBACK_TEXT = 2000;

/** Validates a POST /sessions/:id/feedback body. Throws 400 `bad_feedback`. */
export function parseFeedback(body: unknown): { rating: number; text: string | null } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.badRequest('bad_feedback', 'body must be a JSON object { rating, text? }');
  }
  const { rating, text } = body as { rating?: unknown; text?: unknown };
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw ApiError.badRequest('bad_feedback', 'rating must be an integer from 1 to 5');
  }
  if (text !== undefined && text !== null && typeof text !== 'string') {
    throw ApiError.badRequest('bad_feedback', 'text must be a string');
  }
  if (typeof text === 'string' && text.length > MAX_FEEDBACK_TEXT) {
    throw ApiError.badRequest('bad_feedback', `text must be at most ${MAX_FEEDBACK_TEXT} characters`);
  }
  return { rating, text: typeof text === 'string' && text.length > 0 ? text : null };
}
