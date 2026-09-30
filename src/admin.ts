import type { Hono } from 'hono';
import type { Env } from './env';
import { requireServiceAuth } from './auth';
import { ApiError } from './lib/errors';
import { currentKey, manifestKey, previousKey, rebuildIndex } from './labs/bundle';

/**
 * Back-office routes for the admin panel (admin/). Every one takes the
 * service key and nothing else: the admin Worker holds the key and the panel's
 * own password is the gate in front of it, so a session token has no business
 * here and is refused exactly as it is on `/pools`.
 *
 * Queries are parameterised, bounded (a page is at most 200 rows; aggregate
 * lists are capped) and tolerant of a table or column that has not been
 * migrated yet, which reads as "not available" rather than a 500.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BY_LAB_LIMIT = 20;
const BY_DAY_LIMIT = 366;
const MAX_STATES = 8;
const LEARNING_QUESTION_LIMIT = 500;
const LEARNING_CONCEPT_LIMIT = 200;
/** Larger than any created_at, so an absent cursor is just "everything". */
const NO_CURSOR = Number.MAX_SAFE_INTEGER;

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const STATE = /^[a-z_]{1,20}$/;

/** `?limit=`: default 50, clamped to 1-200; anything unreadable is the default. */
export function pageLimit(raw: string | undefined): number {
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/** `?before=`: an epoch-ms cursor, the `next` of the previous page. */
export function parseBefore(raw: string | undefined): number {
  if (raw === undefined || raw === '') return NO_CURSOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('bad_cursor', '`before` must be an epoch-ms number');
  return Math.floor(n);
}

/** Epoch milliseconds, or anything `Date.parse` reads as an ISO date. */
export function parseInstant(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  // Digits are epoch ms; anything else must at least look like an ISO date, since Date.parse reads "-5" as a year.
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('bad_window', `${name} must be epoch milliseconds or an ISO date`);
  return Math.floor(n);
}

/** True when D1 says a table or column is not there yet (a migration that has not run). */
export function isMissingSchema(err: unknown): boolean {
  return /no such (table|column)/i.test(err instanceof Error ? err.message : String(err));
}

const round = (n: number | null | undefined, places = 6): number => {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : 0;
};

interface SessionRow {
  id: string;
  user_id: string;
  lab_slug: string;
  lab_version: string;
  family: string;
  state: string;
  created_at: number;
  started_at: number | null;
  expires_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  resumed_count: number;
  cost_usd: number | null;
  llm_usd: number | null;
  running_s: number | null;
  completed_at: number | null;
  hints_delivered: number | null;
}

export function mountAdmin(app: Hono<{ Bindings: Env }>): void {
  // --- Sessions in any state, newest first ---

  app.get('/admin/sessions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const q = c.req.query();
    const limit = pageLimit(q.limit);
    const before = parseBefore(q.before);

    const where = ['created_at < ?'];
    const params: unknown[] = [before];
    if (q.state) {
      const states = q.state.split(',').map((s) => s.trim()).filter(Boolean);
      if (states.length === 0 || states.length > MAX_STATES || !states.every((s) => STATE.test(s))) {
        throw ApiError.badRequest('bad_state', `state must be up to ${MAX_STATES} comma-separated state names`);
      }
      where.push(`state IN (${states.map(() => '?').join(', ')})`);
      params.push(...states);
    }
    if (q.lab) {
      where.push('lab_slug = ?');
      params.push(q.lab);
    }
    if (q.user) {
      where.push('user_id = ?');
      params.push(q.user);
    }

    const result = await c.env.DB.prepare(
      `SELECT id, user_id, lab_slug, lab_version, family, state, created_at, started_at, expires_at, ended_at, end_reason,
              resumed_count, cost_usd, llm_usd, running_s, completed_at, hints_delivered
         FROM sessions
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
      .bind(...params, limit + 1)
      .all<SessionRow>();

    const rows = result.results ?? [];
    const sessions = rows.slice(0, limit);
    return c.json(rows.length > limit ? { sessions, next: sessions[sessions.length - 1]!.created_at } : { sessions });
  });

  // --- Usage and cost ---

  app.get('/admin/usage/summary', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const now = Date.now();
    const to = parseInstant('to', c.req.query('to')) ?? now;
    const from = parseInstant('from', c.req.query('from')) ?? Math.max(0, to - DEFAULT_WINDOW_MS);
    if (from >= to) throw ApiError.badRequest('bad_window', 'from must be earlier than to');
    const win = [from, to];
    const db = c.env.DB;

    const [totals, byLab, byDay] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS sessions,
                  COALESCE(SUM(running_s), 0) AS running_s,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(llm_usd), 0) AS llm_usd,
                  COALESCE(SUM(CASE WHEN state = 'ended' THEN 1 ELSE 0 END), 0) AS ended,
                  COALESCE(SUM(CASE WHEN state = 'ended' AND completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed
             FROM sessions
            WHERE created_at >= ? AND created_at < ?`
        )
        .bind(...win)
        .first<Record<string, number>>(),
      db
        .prepare(
          `SELECT lab_slug,
                  COUNT(*) AS sessions,
                  COALESCE(SUM(running_s), 0) AS running_s,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(llm_usd), 0) AS llm_usd,
                  COALESCE(SUM(CASE WHEN state = 'ended' AND completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed
             FROM sessions
            WHERE created_at >= ? AND created_at < ?
            GROUP BY lab_slug
            ORDER BY cost_usd DESC, sessions DESC, lab_slug ASC
            LIMIT ?`
        )
        .bind(...win, BY_LAB_LIMIT)
        .all<Record<string, string | number>>(),
      db
        .prepare(
          `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
                  COUNT(*) AS sessions,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
             FROM sessions
            WHERE created_at >= ? AND created_at < ?
            GROUP BY day
            ORDER BY day DESC
            LIMIT ?`
        )
        .bind(...win, BY_DAY_LIMIT)
        .all<Record<string, string | number>>(),
    ]);

    const ended = Number(totals?.ended ?? 0);
    const completed = Number(totals?.completed ?? 0);
    return c.json({
      from,
      to,
      totals: {
        sessions: Number(totals?.sessions ?? 0),
        running_s: Number(totals?.running_s ?? 0),
        cost_usd: round(totals?.cost_usd),
        llm_usd: round(totals?.llm_usd),
      },
      by_lab: (byLab.results ?? []).map((r) => ({
        lab_slug: String(r.lab_slug),
        sessions: Number(r.sessions),
        running_s: Number(r.running_s),
        cost_usd: round(r.cost_usd as number),
        llm_usd: round(r.llm_usd as number),
        completed: Number(r.completed),
      })),
      // Oldest first, so a chart can draw it left to right.
      by_day: (byDay.results ?? [])
        .map((r) => ({ day: String(r.day), sessions: Number(r.sessions), cost_usd: round(r.cost_usd as number) }))
        .reverse(),
      // Of the sessions that have ended, the share that passed every check.
      completion: { completed, ended, rate: ended > 0 ? completed / ended : null },
    });
  });

  // --- Users: distinct user_id, nothing more ---

  app.get('/admin/users', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const limit = pageLimit(c.req.query('limit'));
    const before = parseBefore(c.req.query('before'));

    const run = (withPlan: boolean) =>
      c.env.DB.prepare(
        `SELECT s.user_id AS user_id,
                COUNT(*) AS sessions,
                MAX(s.created_at) AS last_session_at,
                COALESCE(SUM(s.cost_usd), 0) AS cost_usd,
                COALESCE(SUM(CASE WHEN s.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed,
                ${withPlan ? 'MAX(u.plan)' : 'NULL'} AS plan
           FROM sessions s
           ${withPlan ? 'LEFT JOIN users u ON u.id = s.user_id' : ''}
          GROUP BY s.user_id
         HAVING MAX(s.created_at) < ?
          ORDER BY last_session_at DESC, s.user_id ASC
          LIMIT ?`
      )
        .bind(before, limit + 1)
        .all<Record<string, string | number | null>>();

    // The users table is newer than sessions; without it the plan is unknown, not an error.
    let result;
    try {
      result = await run(true);
    } catch (err) {
      if (!isMissingSchema(err)) throw err;
      result = await run(false);
    }
    const rows = result.results ?? [];
    const users = rows.slice(0, limit).map((r) => ({
      user_id: String(r.user_id),
      sessions: Number(r.sessions),
      last_session_at: Number(r.last_session_at),
      cost_usd: round(r.cost_usd as number),
      completed: Number(r.completed),
      plan: (r.plan as string | null) ?? null,
    }));
    return c.json(rows.length > limit ? { users, next: users[users.length - 1]!.last_session_at } : { users });
  });

  // --- Waitlist and feedback (tables that may not exist yet) ---

  app.get('/admin/waitlist', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const limit = pageLimit(c.req.query('limit'));
    const before = parseBefore(c.req.query('before'));
    try {
      const result = await c.env.DB.prepare(
        `SELECT email, plan, role, country, source, created_at, updated_at
           FROM waitlist
          WHERE created_at < ?
          ORDER BY created_at DESC, email ASC
          LIMIT ?`
      )
        .bind(before, limit + 1)
        .all<{ created_at: number }>();
      const all = result.results ?? [];
      const rows = all.slice(0, limit);
      return c.json({ available: true, rows, ...(all.length > limit ? { next: rows[rows.length - 1]!.created_at } : {}) });
    } catch (err) {
      if (!isMissingSchema(err)) throw err;
      return c.json({ available: false, rows: [] });
    }
  });

  app.get('/admin/feedback', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const limit = pageLimit(c.req.query('limit'));
    const before = parseBefore(c.req.query('before'));
    const db = c.env.DB;

    type FeedbackRow = {
      source: 'lab' | 'site';
      id: string;
      created_at: number;
      rating: number | null;
      message: string | null;
      lab_slug: string | null;
      user_id: string | null;
      session_id: string | null;
      email: string | null;
      country: string | null;
      origin: string | null;
    };
    const blank = { lab_slug: null, user_id: null, session_id: null, email: null, country: null, origin: null };

    // Each source on its own: a deployment with only one of the tables still shows that one.
    const load = async (sql: string, shape: (r: Record<string, unknown>) => FeedbackRow): Promise<FeedbackRow[] | null> => {
      try {
        const result = await db.prepare(sql).bind(before, limit + 1).all<Record<string, unknown>>();
        return (result.results ?? []).map(shape);
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        return null;
      }
    };

    const [lab, site] = await Promise.all([
      load(
        `SELECT id, session_id, user_id, lab_slug, rating, text, created_at
           FROM feedback WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        (r) => ({
          ...blank,
          source: 'lab',
          id: String(r.id),
          created_at: Number(r.created_at),
          rating: (r.rating as number | null) ?? null,
          message: (r.text as string | null) ?? null,
          lab_slug: (r.lab_slug as string | null) ?? null,
          user_id: (r.user_id as string | null) ?? null,
          session_id: (r.session_id as string | null) ?? null,
        })
      ),
      load(
        `SELECT id, rating, message, email, country, source, created_at
           FROM feedback_site WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        (r) => ({
          ...blank,
          source: 'site',
          id: String(r.id),
          created_at: Number(r.created_at),
          rating: (r.rating as number | null) ?? null,
          message: (r.message as string | null) ?? null,
          email: (r.email as string | null) ?? null,
          country: (r.country as string | null) ?? null,
          // The site's own `source` column (which link sent them) is not this row's `source`.
          origin: (r.source as string | null) ?? null,
        })
      ),
    ]);

    if (lab === null && site === null) return c.json({ available: false, rows: [] });

    const merged = [...(lab ?? []), ...(site ?? [])].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
    const rows = merged.slice(0, limit);
    return c.json({
      available: true,
      ...(lab === null || site === null ? { missing: lab === null ? ['feedback'] : ['feedback_site'] } : {}),
      rows,
      ...(merged.length > limit ? { next: rows[rows.length - 1]!.created_at } : {}),
    });
  });

  // --- Learning analytics: how learners answer the quiz questions ---

  // Aggregates of the anonymous learn_answers table (no user id anywhere on
  // it). `?lab=` narrows to one lab, `?from=` / `?to=` to a window (default:
  // all time). Onboarding answers have no lab and come back with
  // `lab_slug: null`. Rows are ordered so the weakest questions (lowest
  // percent_correct, then most attempts) come first.
  app.get('/admin/learning', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const q = c.req.query();
    const from = parseInstant('from', q.from);
    const to = parseInstant('to', q.to);
    if (from !== undefined && to !== undefined && from >= to) throw ApiError.badRequest('bad_window', 'from must be earlier than to');
    if (q.lab !== undefined && q.lab !== '' && !SLUG.test(q.lab)) throw ApiError.badRequest('bad_lab', 'lab must be a lab slug');

    const where: string[] = [];
    const params: unknown[] = [];
    if (from !== undefined) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('created_at < ?');
      params.push(to);
    }
    if (q.lab) {
      where.push('lab_slug = ?');
      params.push(q.lab);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const [byQuestion, byConcept] = await Promise.all([
        c.env.DB.prepare(
          `SELECT lab_slug, question_id, MAX(concept) AS concept,
                  COUNT(*) AS attempts, SUM(correct) AS correct
             FROM learn_answers ${clause}
            GROUP BY lab_slug, question_id
            ORDER BY (1.0 * SUM(correct) / COUNT(*)) ASC, attempts DESC, lab_slug ASC, question_id ASC
            LIMIT ?`
        )
          .bind(...params, LEARNING_QUESTION_LIMIT)
          .all<Record<string, string | number | null>>(),
        c.env.DB.prepare(
          `SELECT concept, COUNT(*) AS attempts, SUM(correct) AS correct
             FROM learn_answers ${clause}
            GROUP BY concept
            ORDER BY concept ASC
            LIMIT ?`
        )
          .bind(...params, LEARNING_CONCEPT_LIMIT)
          .all<Record<string, string | number | null>>(),
      ]);
      const percent = (correct: number, attempts: number) => (attempts > 0 ? round((100 * correct) / attempts, 1) : null);
      const questions = (byQuestion.results ?? []).map((r) => {
        const attempts = Number(r.attempts);
        const correct = Number(r.correct ?? 0);
        return {
          lab_slug: (r.lab_slug as string | null) ?? null,
          question_id: String(r.question_id),
          concept: String(r.concept),
          attempts,
          correct,
          percent_correct: percent(correct, attempts),
        };
      });
      const concepts = (byConcept.results ?? []).map((r) => {
        const attempts = Number(r.attempts);
        const correct = Number(r.correct ?? 0);
        return { concept: String(r.concept), attempts, correct, percent_correct: percent(correct, attempts) };
      });
      return c.json({ available: true, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), questions, concepts });
    } catch (err) {
      if (!isMissingSchema(err)) throw err;
      return c.json({ available: false, questions: [], concepts: [] });
    }
  });

  // --- Catalogue: versions and promotion ---

  app.get('/labs/:slug/versions', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const slug = c.req.param('slug');
    if (!SLUG.test(slug)) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);

    const [current, previous, found] = await Promise.all([
      readPointer(c.env, currentKey(slug)),
      readPointer(c.env, previousKey(slug)),
      listVersions(c.env, slug),
    ]);
    if (current === null && found.length === 0) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);

    const versions: Array<Record<string, unknown>> = [];
    const WIDTH = 16;
    for (let i = 0; i < found.length; i += WIDTH) {
      versions.push(
        ...(await Promise.all(
          found.slice(i, i + WIDTH).map(async ({ version, uploaded }) => {
            const base = { version, current: version === current, previous: version === previous, published_at: uploaded };
            try {
              const obj = await c.env.LABS_BUCKET.get(manifestKey(slug, version));
              const m = obj ? ((await obj.json()) as { title?: unknown; version?: unknown; estimated_minutes?: unknown }) : null;
              if (!m) return { ...base, title: null, manifest_version: null, estimated_minutes: null, error: 'manifest missing' };
              return {
                ...base,
                title: typeof m.title === 'string' ? m.title : null,
                manifest_version: typeof m.version === 'string' ? m.version : null,
                estimated_minutes: typeof m.estimated_minutes === 'number' ? m.estimated_minutes : null,
              };
            } catch {
              return { ...base, title: null, manifest_version: null, estimated_minutes: null, error: 'manifest unreadable' };
            }
          })
        ))
      );
    }
    // Newest version first.
    versions.sort((a, b) => compareSemver(String(b.version), String(a.version)));
    return c.json({ slug, current, previous, versions });
  });

  app.post('/labs/:slug/promote', async (c) => {
    requireServiceAuth(c.req.raw, c.env);
    const slug = c.req.param('slug');
    const body = await c.req.json<{ version?: unknown }>().catch((): { version?: unknown } => ({}));
    const version = typeof body?.version === 'string' ? body.version : '';
    if (!SLUG.test(slug)) throw ApiError.notFound('lab_not_found', `No published lab "${slug}"`);
    if (!SEMVER.test(version)) throw ApiError.badRequest('bad_version', '`version` must be a semver string such as 1.2.0');

    if (!(await c.env.LABS_BUCKET.head(manifestKey(slug, version)))) {
      throw ApiError.notFound('unknown_version', `Lab "${slug}" has no published version ${version}`);
    }

    const old = await readPointer(c.env, currentKey(slug));
    // Already current: leave both pointers alone (promoting must not turn
    // `previous` into the version it just promoted), but still rebuild the
    // index, which repairs one that has drifted.
    if (old !== version) {
      if (old) await c.env.LABS_BUCKET.put(previousKey(slug), old);
      await c.env.LABS_BUCKET.put(currentKey(slug), version);
    }
    await rebuildIndex(c.env);

    return c.json({ slug, current: version, previous: await readPointer(c.env, previousKey(slug)) });
  });
}

/** A pointer object's trimmed text, or null when it does not exist or is empty. */
async function readPointer(env: Env, key: string): Promise<string | null> {
  const obj = await env.LABS_BUCKET.get(key);
  if (!obj) return null;
  const text = (await obj.text()).trim();
  return text || null;
}

/** Every `labs/{slug}/{version}/manifest.json` in R2, following the list cursor. */
async function listVersions(env: Env, slug: string): Promise<Array<{ version: string; uploaded: number | null }>> {
  const prefix = `labs/${slug}/`;
  const found: Array<{ version: string; uploaded: number | null }> = [];
  let cursor: string | undefined;
  // A lab has a handful of versions; the page bound only stops a runaway loop.
  for (let page = 0; page < 50; page++) {
    const listed = await env.LABS_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of listed.objects) {
      const rest = obj.key.slice(prefix.length);
      const m = /^([^/]+)\/manifest\.json$/.exec(rest);
      if (!m) continue;
      const uploaded = obj.uploaded instanceof Date ? obj.uploaded.getTime() : null;
      found.push({ version: m[1]!, uploaded });
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return found;
}

/** Descending-friendly semver compare; a non-semver version sorts below any semver one. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) => (SEMVER.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}
