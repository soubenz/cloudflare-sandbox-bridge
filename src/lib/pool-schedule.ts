/**
 * Time-of-day warm-pool targets.
 *
 * A schedule is a semicolon-separated list of rules, evaluated in UTC, first
 * match wins:
 *
 *   "mon-fri 07-21=1; *=0"
 *
 * - `<days> <HH-HH>=<target>`: applies on those days for hours in [start, end).
 *   `<days>` is `*`, or a comma list of day names / day ranges (`mon-fri`,
 *   `sat,sun`, `mon,wed-fri`; a range may wrap the week, e.g. `fri-mon`).
 *   Hours are 0-24 and start must be below end.
 * - `*=<target>`: applies at any time; use it last as the default.
 *
 * Anything that does not parse makes the whole schedule unusable, and
 * `resolvePoolTarget` then returns its fallback (the static POOL_TARGET_*
 * var) rather than guessing which half of a broken schedule was meant.
 */

export interface PoolScheduleRule {
  /** Days of week (0 = Sunday … 6 = Saturday, as `Date#getUTCDay`), or null for every day. */
  days: ReadonlySet<number> | null;
  /** Hour window [start, end), or null for the whole day. */
  hours: { start: number; end: number } | null;
  target: number;
}

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDays(spec: string): ReadonlySet<number> | null {
  if (spec === '*') return null;
  const days = new Set<number>();
  for (const part of spec.split(',')) {
    const range = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(part);
    const from = range ? DAY_INDEX[range[1]!] : undefined;
    const to = range?.[2] === undefined ? from : DAY_INDEX[range[2]];
    if (!range || from === undefined || to === undefined) throw new Error(`bad days "${spec}"`);
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return days;
}

function parseTarget(raw: string, rule: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`bad target in "${rule}"`);
  return Number.parseInt(raw, 10);
}

/** Parses a schedule string. Throws on any malformed rule. */
export function parsePoolSchedule(schedule: string): PoolScheduleRule[] {
  const rules: PoolScheduleRule[] = [];
  for (const raw of schedule.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    const eq = rule.lastIndexOf('=');
    if (eq === -1) throw new Error(`missing "=" in "${rule}"`);
    const lhs = rule.slice(0, eq).trim().toLowerCase();
    const target = parseTarget(rule.slice(eq + 1).trim(), rule);
    if (lhs === '*') {
      rules.push({ days: null, hours: null, target });
      continue;
    }
    const m = /^(\S+)\s+(\d{1,2})-(\d{1,2})$/.exec(lhs);
    if (!m) throw new Error(`bad rule "${rule}"`);
    const start = Number.parseInt(m[2]!, 10);
    const end = Number.parseInt(m[3]!, 10);
    if (start > 23 || end > 24 || start >= end) throw new Error(`bad hours in "${rule}"`);
    rules.push({ days: parseDays(m[1]!), hours: { start, end }, target });
  }
  if (rules.length === 0) throw new Error('no rules');
  return rules;
}

const warned = new Set<string>();

/**
 * The warm-pool target at `at` (UTC). Returns `fallback` when the schedule is
 * undefined, blank, unparseable (logged once per distinct string), or has no
 * rule that matches `at`.
 */
export function resolvePoolTarget(schedule: string | undefined, fallback: number, at: Date): number {
  if (schedule === undefined || schedule.trim() === '') return fallback;
  let rules: PoolScheduleRule[];
  try {
    rules = parsePoolSchedule(schedule);
  } catch (err) {
    if (!warned.has(schedule)) {
      warned.add(schedule);
      console.warn(`pool schedule "${schedule}" ignored, using fallback target ${fallback}: ${(err as Error).message}`);
    }
    return fallback;
  }
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  for (const rule of rules) {
    if (rule.days && !rule.days.has(day)) continue;
    if (rule.hours && (hour < rule.hours.start || hour >= rule.hours.end)) continue;
    return rule.target;
  }
  return fallback;
}
