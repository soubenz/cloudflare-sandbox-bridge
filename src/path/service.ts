import type { Env } from '../env';
import { loadCatalogue, type LabIndexEntry } from '../labs/bundle';
import { ApiError } from '../lib/errors';
import { AREAS, applyRules, labArea, type AreaLevel, type LockInfo, type Plan, type RulesResult } from './rules';
import { PATH_MODEL, PROMPT_VERSION, cleanWhy, gatewayAiCall, orderWithAi, buildPrompt, ORDER_SCHEMA, type AiCall, type AiStep } from './ai';
import { fixOrder } from './validate';
import { nextLabs } from './next';
import type { PathInputs } from './inputs';

/**
 * The personal learning path: D1 reads and writes, the cache, and the
 * orchestration of rules -> model -> validation. The pure parts are in
 * rules.ts, validate.ts and (the model call) ai.ts.
 */

/** Used when a manifest sets no `estimated_minutes`. */
export const DEFAULT_MINUTES = 30;

export type StepStatus = 'done' | 'next' | 'upcoming' | 'locked';

/** Why a step is locked: `plan` (a paid plan unlocks it) or `prerequisite` (it opens after another locked lab). */
export type StepLock = 'plan' | 'prerequisite';

export interface PathStep {
  slug: string;
  title: string;
  area: string | null;
  why: string;
  estimated_minutes: number;
  status: StepStatus;
  /** Only on a `locked` step. */
  lock?: StepLock;
}

export interface PathJson {
  /** Completed labs first, then the labs still to do in order, then labs the plan locks. */
  steps: PathStep[];
  /** Minutes still to do: steps that are neither done nor locked. */
  total_minutes: number;
  /** Weeks to finish `total_minutes` at the learner's hours per week, rounded up; 0 when nothing is left. */
  weeks_estimate: number;
  goal: { text: string | null; kind: PathInputs['goal_kind'] };
  /** 'ai' when a model ordered the labs, 'rules' when the rules' order is used (the model failed, timed out, or there was nothing to order). */
  source: 'ai' | 'rules';
  /** ms since epoch. */
  generated_at: number;
}

export interface PathDeps {
  /** The model call; defaults to the AI Gateway. Tests pass a stub, so none touches the network. */
  ai?: AiCall;
  now?: () => number;
  /** Overrides the model's time limit (AI_TIMEOUT_MS); for tests. */
  timeoutMs?: number;
}

export type CacheState = 'hit' | 'miss' | 'forced';

export interface PathResult {
  path: PathJson;
  cache: CacheState;
}

// ---------------------------------------------------------------------------
// Pure: hash and assembly

/** Stable JSON: object keys sorted, so the same data always serialises the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The cache key: SHA-256 of everything the path is built from. Same hash,
 * same path, no model call. The labs allowed (slug + version, sorted), the
 * labs locked and the completed set are in it, so a new lab version, a
 * completed lab or a plan change makes a new key; the model and prompt
 * version are in it so that changing either re-asks.
 */
export async function inputHash(inputs: PathInputs, plan: Plan, rules: RulesResult, completed: ReadonlySet<string>): Promise<string> {
  const labs = (list: LabIndexEntry[]) => list.map((l) => `${l.slug}@${l.version}`).sort();
  return sha256Hex(
    canonical({
      v: PROMPT_VERSION,
      model: PATH_MODEL,
      areas: inputs.areas,
      goal_text: inputs.goal_text,
      goal_kind: inputs.goal_kind,
      hours_per_week: inputs.hours_per_week,
      plan,
      allowed: labs(rules.allowed),
      locked: labs(rules.locked),
      completed: [...completed].sort(),
    })
  );
}

/** The stock reason of a plan lock. */
export const PLAN_LOCK_WHY = 'Included with the Pro plan.';

/** The reason and kind of a lock. A prerequisite's title is plain text, cut so the line stays within the 120 characters of a `why`. */
export function lockedStep(info: LockInfo): { lock: StepLock; why: string } {
  if (info.lock === 'plan') return { lock: 'plan', why: PLAN_LOCK_WHY };
  const title = info.by.title.length > 80 ? `${info.by.title.slice(0, 79)}…` : info.by.title;
  return { lock: 'prerequisite', why: `Unlocks after ${title}.` };
}

/** The reason shown when the model gave none (or none fit to show). Plain words, no implementation detail. */
export function genericWhy(lab: LabIndexEntry, rules: Pick<RulesResult, 'capstones' | 'foundations'>, areaTitle: string | null): string {
  if (rules.capstones.has(lab.slug)) return `One lab to confirm what you already know about ${areaTitle ?? 'this area'}.`;
  if (rules.foundations.has(lab.slug)) return `A first step into ${areaTitle ?? 'this area'}, which is new to you.`;
  return areaTitle ? `Builds on the earlier steps in ${areaTitle}.` : 'The next step on your path.';
}

export interface AssembleArgs {
  inputs: PathInputs;
  rules: RulesResult;
  /** The allowed labs in their final order (already validated). */
  order: LabIndexEntry[];
  /** Reasons by slug (from the model, or kept from a stored path); anything missing or unfit gets the generic one. */
  whys: ReadonlyMap<string, string | null>;
  source: 'ai' | 'rules';
  now: number;
}

/** Builds the stored/returned path JSON. Pure. */
export function assemblePath(a: AssembleArgs): PathJson {
  const minutes = (l: LabIndexEntry) => l.estimated_minutes ?? DEFAULT_MINUTES;
  const areaTitle = (l: LabIndexEntry) => {
    const id = labArea(l);
    return id ? (AREAS[id]?.title ?? null) : null;
  };
  const step = (l: LabIndexEntry, why: string, status: StepStatus, lock?: StepLock): PathStep => ({
    slug: l.slug,
    title: l.title,
    area: labArea(l),
    why,
    estimated_minutes: minutes(l),
    status,
    ...(lock ? { lock } : {}),
  });
  const lockedStepFor = (l: LabIndexEntry): PathStep => {
    const { lock, why } = lockedStep(a.rules.locks.get(l.slug) ?? { lock: 'plan' });
    return step(l, why, 'locked', lock);
  };
  // Which step is `next` is the one shared rule (next.ts). Every lab in `order` is one the plan can start
  // (the rules keep locked labs out of it), so the plan given here changes nothing.
  const next = nextLabs(
    a.order.map((l) => ({ slug: l.slug, status: 'upcoming' })),
    [...a.rules.done.map((l) => ({ lab: l, completion: true })), ...a.order.map((l) => ({ lab: l, completion: null }))],
    'pro'
  ).overall?.slug;
  const steps: PathStep[] = [
    ...a.rules.done.map((l) => step(l, 'You have already finished this lab.', 'done')),
    ...a.order.map((l) => step(l, cleanWhy(a.whys.get(l.slug)) ?? genericWhy(l, a.rules, areaTitle(l)), l.slug === next ? 'next' : 'upcoming')),
    ...a.rules.locked.map(lockedStepFor),
  ];
  const total = a.order.reduce((sum, l) => sum + minutes(l), 0);
  return {
    steps,
    total_minutes: total,
    weeks_estimate: total === 0 ? 0 : Math.ceil(total / (a.inputs.hours_per_week * 60)),
    goal: { text: a.inputs.goal_text, kind: a.inputs.goal_kind },
    source: a.source,
    generated_at: a.now,
  };
}

// ---------------------------------------------------------------------------
// D1

interface InputsRow {
  areas_json: string;
  goal_text: string | null;
  goal_kind: PathInputs['goal_kind'];
  hours_per_week: number;
}

export async function loadInputs(env: Env, userId: string): Promise<PathInputs | null> {
  const row = await env.DB.prepare(`SELECT areas_json, goal_text, goal_kind, hours_per_week FROM user_profile_inputs WHERE user_id = ?`)
    .bind(userId)
    .first<InputsRow>();
  if (!row) return null;
  return { areas: JSON.parse(row.areas_json) as Record<string, AreaLevel>, goal_text: row.goal_text, goal_kind: row.goal_kind, hours_per_week: row.hours_per_week };
}

export async function saveInputs(env: Env, userId: string, inputs: PathInputs, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_profile_inputs (user_id, areas_json, goal_text, goal_kind, hours_per_week, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET areas_json = excluded.areas_json, goal_text = excluded.goal_text,
       goal_kind = excluded.goal_kind, hours_per_week = excluded.hours_per_week, updated_at = excluded.updated_at`
  )
    .bind(userId, canonical(inputs.areas), inputs.goal_text, inputs.goal_kind, inputs.hours_per_week, now)
    .run();
}

interface StoredPath {
  input_hash: string;
  path: PathJson;
  source: 'ai' | 'rules';
  model: string | null;
}

async function loadStored(env: Env, userId: string): Promise<StoredPath | null> {
  const row = await env.DB.prepare(`SELECT input_hash, path_json, source, model FROM user_paths WHERE user_id = ?`)
    .bind(userId)
    .first<{ input_hash: string; path_json: string; source: 'ai' | 'rules'; model: string | null }>();
  if (!row) return null;
  try {
    return { input_hash: row.input_hash, path: JSON.parse(row.path_json) as PathJson, source: row.source, model: row.model };
  } catch {
    return null; // an unreadable row is no cache; it is replaced on the next write
  }
}

/** The steps of the user's stored path, as last written (null when there is none). The profile reads them for its "next lab". */
export async function loadPathSteps(env: Env, userId: string): Promise<PathStep[] | null> {
  const stored = await loadStored(env, userId);
  return stored && Array.isArray(stored.path.steps) ? stored.path.steps : null;
}

async function storePath(env: Env, userId: string, hash: string, path: PathJson, model: string | null, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_paths (user_id, input_hash, path_json, source, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET input_hash = excluded.input_hash, path_json = excluded.path_json,
       source = excluded.source, model = excluded.model, updated_at = excluded.updated_at`
  )
    .bind(userId, hash, JSON.stringify(path), path.source, model, now, now)
    .run();
}

/** Labs the user has passed every check of (`check_runs.passed_all`), the same fact `GET /users/:uid/progress` reports. */
export async function loadCompleted(env: Env, userId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(`SELECT DISTINCT lab_slug FROM check_runs WHERE user_id = ? AND passed_all = 1 AND lab_slug IS NOT NULL`)
    .bind(userId)
    .all<{ lab_slug: string }>();
  return new Set((rows.results ?? []).map((r) => r.lab_slug));
}

/** The user's plan from `users.plan`; no row means 'free', the column's default. Anything but 'free' is paid. */
export async function loadPlan(env: Env, userId: string): Promise<Plan> {
  const row = await env.DB.prepare(`SELECT plan FROM users WHERE id = ?`).bind(userId).first<{ plan: string | null }>();
  return !row || !row.plan || row.plan === 'free' ? 'free' : 'pro';
}

// ---------------------------------------------------------------------------
// Orchestration

interface Context {
  plan: Plan;
  completed: Set<string>;
  rules: RulesResult;
  hash: string;
}

/** Reads the catalogue, the user's completions and plan, applies the rules and hashes the result. No model call. */
async function buildContext(env: Env, userId: string, inputs: PathInputs): Promise<Context> {
  const [catalogue, completed, plan] = await Promise.all([loadCatalogue(env), loadCompleted(env, userId), loadPlan(env, userId)]);
  const rules = applyRules({ catalogue, levels: inputs.areas, plan, completed });
  return { plan, completed, rules, hash: await inputHash(inputs, plan, rules, completed) };
}

function promptFor(inputs: PathInputs, rules: RulesResult) {
  const allowed = new Set(rules.allowed.map((l) => l.slug));
  return buildPrompt({
    goal_text: inputs.goal_text,
    goal_kind: inputs.goal_kind,
    hours_per_week: inputs.hours_per_week,
    levels: Object.fromEntries(Object.entries(inputs.areas).map(([id, lvl]) => [AREAS[id]?.title ?? id, lvl])),
    labs: rules.allowed.map((l) => {
      const id = labArea(l);
      return {
        slug: l.slug,
        title: l.title,
        area: id ? (AREAS[id]?.title ?? id) : null,
        ...(l.difficulty ? { difficulty: l.difficulty } : {}),
        estimated_minutes: l.estimated_minutes ?? DEFAULT_MINUTES,
        prerequisites: (l.prerequisites ?? []).filter((p) => allowed.has(p)),
      };
    }),
  });
}

/** Never throws: the fallback is the rules' own order. The goal text is never logged. */
async function askModel(call: AiCall, inputs: PathInputs, rules: RulesResult, skipCache: boolean, timeoutMs?: number): Promise<AiStep[] | null> {
  try {
    return await orderWithAi(call, { model: PATH_MODEL, ...promptFor(inputs, rules), schema: ORDER_SCHEMA, skipCache }, timeoutMs);
  } catch (err) {
    console.warn('learning path: model ordering failed, using the rules order:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * A path stored before steps carried `lock` has locked steps without one. The rules know why each is locked
 * and nothing else about the path changed (the hash matches), so fill it in rather than serve a step whose
 * lock kind is missing. Returns the same object when there is nothing to fill in.
 */
function withLocks(path: PathJson, rules: RulesResult): PathJson {
  if (path.steps.every((s) => s.status !== 'locked' || s.lock)) return path;
  return {
    ...path,
    steps: path.steps.map((s) => {
      if (s.status !== 'locked' || s.lock) return s;
      const info = rules.locks.get(s.slug);
      return info ? { ...s, ...lockedStep(info) } : { ...s, lock: 'plan' };
    }),
  };
}

/**
 * The user's path, from the cache when nothing it was built from has
 * changed, otherwise rebuilt: the rules choose the labs, the model (when
 * there are at least two to order) orders them, and the server validates its
 * answer. A model failure or timeout is not an error: the rules' order is
 * used with `source: 'rules'`. `force` skips the cache (and the gateway's).
 * 404 `no_inputs` when the user never gave inputs.
 */
export async function ensurePath(env: Env, userId: string, opts: { force?: boolean } = {}, deps: PathDeps = {}): Promise<PathResult> {
  const inputs = await loadInputs(env, userId);
  if (!inputs) throw ApiError.notFound('no_inputs', 'This user has not taken the quiz yet; send PUT /users/:uid/path-inputs first');
  const now = (deps.now ?? Date.now)();
  const ctx = await buildContext(env, userId, inputs);

  if (!opts.force) {
    const stored = await loadStored(env, userId);
    if (stored && stored.input_hash === ctx.hash) return { path: withLocks(stored.path, ctx.rules), cache: 'hit' };
  }

  const { rules } = ctx;
  let proposed: AiStep[] | null = null;
  if (rules.allowed.length >= 2) proposed = await askModel(deps.ai ?? gatewayAiCall(env), inputs, rules, opts.force === true, deps.timeoutMs);

  const source = proposed ? 'ai' : 'rules';
  const order = proposed ? fixOrder(proposed.map((s) => s.slug), rules.allowed) : rules.allowed;
  // A duplicated slug keeps its first reason, like its first position.
  const whys = new Map<string, string | null>();
  for (const s of proposed ?? []) if (!whys.has(s.slug)) whys.set(s.slug, s.why);
  const path = assemblePath({ inputs, rules, order, whys, source, now });
  await storePath(env, userId, ctx.hash, path, source === 'ai' ? PATH_MODEL : null, now);
  return { path, cache: opts.force ? 'forced' : 'miss' };
}

/** Stores new inputs (a quiz retake, an edit) and recomputes the path from them. */
export async function saveInputsAndRecompute(env: Env, userId: string, inputs: PathInputs, deps: PathDeps = {}): Promise<PathResult> {
  await saveInputs(env, userId, inputs, (deps.now ?? Date.now)());
  return ensurePath(env, userId, {}, deps);
}

/**
 * Called after a lab is completed, never awaited by the completion itself.
 * Rules only, no model: when what the path was built from has changed (the
 * completed lab, usually) it keeps the stored order and the stored reasons,
 * marks the finished labs done, moves `next`, and stores the result under the
 * new hash, so the next read is a cache hit instead of a new model call. A
 * lab that appeared since is appended in rules order with a generic reason.
 * A user with no inputs or no stored path has nothing to refresh (the first
 * read builds it), and an unchanged hash is already current. `POST
 * /users/:uid/path?force=1` asks the model again.
 */
export async function refreshPath(env: Env, userId: string, deps: PathDeps = {}): Promise<'refreshed' | 'current' | 'none'> {
  const inputs = await loadInputs(env, userId);
  if (!inputs) return 'none';
  const stored = await loadStored(env, userId);
  if (!stored) return 'none';
  const ctx = await buildContext(env, userId, inputs);
  if (stored.input_hash === ctx.hash) return 'current';

  const now = (deps.now ?? Date.now)();
  const order = fixOrder(stored.path.steps.map((s) => s.slug), ctx.rules.allowed);
  // Only the reasons written for a lab still to do carry over: a done or locked step's text is a stock line.
  const whys = new Map(stored.path.steps.filter((s) => s.status === 'next' || s.status === 'upcoming').map((s) => [s.slug, s.why] as const));
  const path = assemblePath({ inputs, rules: ctx.rules, order, whys, source: stored.source, now });
  await storePath(env, userId, ctx.hash, path, stored.model, now);
  return 'refreshed';
}
