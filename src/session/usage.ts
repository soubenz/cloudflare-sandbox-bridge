import type { Env, Family } from '../env';
import { ApiError } from '../lib/errors';

/**
 * Container-hours per lab family, from the D1 `sessions` index, priced at a
 * per-hour figure per family. This is an estimate of what a session's
 * container costs, not a bill: it counts wall-clock time from `started_at`
 * (set when the session reaches `running`) to `ended_at`, and ignores the
 * warm pool, which runs whether or not a session uses it. See
 * docs/runbooks/cost.md for how it relates to the Cloudflare invoice.
 */

export const USAGE_FAMILIES: readonly Family[] = ['agent', 'gateway'];
export const DEFAULT_PRICE_PER_HOUR: Record<Family, number> = { agent: 0.074, gateway: 0.148 };
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 3_600_000;

export interface FamilyUsage {
  hours: number;
  usd: number;
  sessions: number;
}

export interface UsageReport {
  from: number;
  to: number;
  by_family: Record<Family, FamilyUsage>;
  total_usd: number;
}

/** One aggregated row per family, as the query below returns it. */
export interface UsageRow {
  family: string;
  sessions: number;
  ms: number | null;
}

/**
 * Sessions overlapping [from, to), one row per family. Each session
 * contributes its overlap with the window: it is clamped to `to` at the top
 * (an unended session counts up to `to`) and to `from` at the bottom.
 * Sessions that never started (no `started_at`) never ran a container and are
 * excluded.
 */
export const USAGE_SQL = `SELECT family,
       COUNT(*) AS sessions,
       SUM(MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?)) AS ms
  FROM sessions
 WHERE started_at IS NOT NULL
   AND started_at < ?
   AND COALESCE(ended_at, ?) > ?
 GROUP BY family`;

/** Parses `?from=&to=` (epoch ms). Defaults to the 30 days ending `now`. */
export function resolveWindow(fromParam: string | undefined, toParam: string | undefined, now: number): { from: number; to: number } {
  const parse = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('bad_window', `${name} must be a non-negative epoch-millisecond number`);
    return Math.floor(n);
  };
  const to = parse('to', toParam) ?? now;
  const from = parse('from', fromParam) ?? Math.max(0, to - DEFAULT_WINDOW_MS);
  if (from >= to) throw ApiError.badRequest('bad_window', 'from must be earlier than to');
  return { from, to };
}

/** `PRICE_PER_HOUR_<FAMILY>` as a non-negative number, else the default. */
export function pricePerHour(env: Env, family: Family): number {
  const raw = family === 'agent' ? env.PRICE_PER_HOUR_AGENT : env.PRICE_PER_HOUR_GATEWAY;
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PRICE_PER_HOUR[family];
}

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** Pure: turns per-family rows into the report. Rows for unknown families are ignored. */
export function aggregateUsage(rows: readonly UsageRow[], window: { from: number; to: number }, prices: Record<Family, number>): UsageReport {
  const by_family = {} as Record<Family, FamilyUsage>;
  let total = 0;
  for (const family of USAGE_FAMILIES) {
    const row = rows.find((r) => r.family === family);
    const hours = Math.max(0, row?.ms ?? 0) / MS_PER_HOUR;
    const usd = hours * prices[family];
    total += usd;
    by_family[family] = { hours: round(hours, 4), usd: round(usd, 4), sessions: row?.sessions ?? 0 };
  }
  return { from: window.from, to: window.to, by_family, total_usd: round(total, 4) };
}

export async function queryUsage(env: Env, window: { from: number; to: number }): Promise<UsageReport> {
  const { from, to } = window;
  const result = await env.DB.prepare(USAGE_SQL).bind(to, to, from, to, to, from).all<UsageRow>();
  const prices = { agent: pricePerHour(env, 'agent'), gateway: pricePerHour(env, 'gateway') };
  return aggregateUsage(result.results ?? [], window, prices);
}
