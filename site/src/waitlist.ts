/**
 * Waitlist signup: the parts that do not need Cloudflare.
 *
 * Kept free of Worker APIs so test/unit can exercise every rule here with a
 * plain object standing in for FormData. worker.ts does the I/O.
 */

export const PLANS = ['individual', 'team'] as const;
export type Plan = (typeof PLANS)[number];

/** The form's role options. Anything else is dropped rather than stored. */
export const ROLES = ['backend', 'platform', 'ml', 'sre', 'manager', 'other'] as const;
export type Role = (typeof ROLES)[number];

export const WAITLIST_PATH = '/waitlist';
export const THANKS_PATH = '/waitlist/thanks';

/** Name of the hidden field only bots fill in. Deliberately plausible. */
export const HONEYPOT_FIELD = 'website';

export type SignupError = 'email' | 'slow' | 'down';

export interface Signup {
  email: string;
  plan: Plan;
  role: Role | null;
  /** Which call to action sent them, e.g. "hero" or "pricing". */
  source: string | null;
}

export type ParseResult =
  | { kind: 'signup'; value: Signup }
  | { kind: 'honeypot' }
  | { kind: 'invalid'; error: SignupError; plan: Plan };

/** Anything FormData-shaped: we only ever read single string fields. */
export interface FieldSource {
  get(name: string): unknown;
}

const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
// Deliberately loose: one @, no spaces, a dot in the domain. Real
// validation is the email we send later; this only stops typos and junk.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const SOURCE_SHAPE = /^[a-z0-9_-]{1,32}$/;

function text(form: FieldSource, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  if (!EMAIL_SHAPE.test(email)) return null;
  const local = email.slice(0, email.indexOf('@'));
  if (local.length > LOCAL_MAX) return null;
  return email;
}

function toPlan(raw: string): Plan {
  return (PLANS as readonly string[]).includes(raw) ? (raw as Plan) : 'individual';
}

function toRole(raw: string): Role | null {
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

function toSource(raw: string): string | null {
  const s = raw.toLowerCase();
  return SOURCE_SHAPE.test(s) ? s : null;
}

export function parseSignup(form: FieldSource): ParseResult {
  if (text(form, HONEYPOT_FIELD) !== '') return { kind: 'honeypot' };

  const plan = toPlan(text(form, 'plan'));
  const email = normaliseEmail(text(form, 'email'));
  if (email === null) return { kind: 'invalid', error: 'email', plan };

  return {
    kind: 'signup',
    value: { email, plan, role: toRole(text(form, 'role')), source: toSource(text(form, 'source')) },
  };
}

/** Where to send someone back to when the signup did not go through. */
export function errorLocation(error: SignupError, plan: Plan = 'individual'): string {
  return `${WAITLIST_PATH}?e=${error}&plan=${plan}`;
}

/**
 * One row per email. Signing up again updates the plan (and the role, if
 * they gave one this time) but keeps when and where they first joined, so
 * the list stays in true arrival order and the first source is the one
 * that counts.
 */
export const UPSERT_SQL = `INSERT INTO waitlist (email, plan, role, country, source, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
ON CONFLICT(email) DO UPDATE SET
  plan = excluded.plan,
  role = COALESCE(excluded.role, waitlist.role),
  updated_at = excluded.updated_at`;

export function upsertParams(s: Signup, country: string | null, now: number): unknown[] {
  return [s.email, s.plan, s.role, country, s.source, now];
}
