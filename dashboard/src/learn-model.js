/**
 * What the console knows about this learner's learning, with no DOM.
 *
 *   - gradeQuestion: is a set of chosen options the right answer
 *   - the mastery record (localStorage 'opalixLearn'): onboarding levels per
 *     platform area, per-concept "known" from lab diagnostics, and the
 *     learner's own overrides ('skipped' / 'forced')
 *   - planLessons: which of a lab's lessons open in full and which fold to
 *     their one-line recap
 *
 * The check decides, the learner overrides: a diagnostic or an onboarding
 * level only sets the default; 'skipped' and 'forced' always win.
 *
 * Nothing here is sent anywhere, and nothing is graded. The record lives in
 * this browser. Storage can be blocked or throw (private windows, previews),
 * so every read and write is wrapped and the store keeps working in memory.
 */

import registry from '../../packages/catalogue/concepts.json';

export const STORAGE_KEY = 'opalixLearn';

/** Onboarding levels, weakest knowledge last. */
export const LEVELS = ['strong', 'ok', 'new'];

const CONCEPT_ID = /^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/;
const AREA_ID = /^[a-z]+$/;
/** The most answers one POST /learn/answers takes. */
export const MAX_ANSWERS = 60;

// ---------------------------------------------------------------------------
// Concepts and areas
// ---------------------------------------------------------------------------

/** "gateway.routing-aliases" -> "gateway". */
export function areaOf(conceptId) {
  const s = String(conceptId ?? '');
  const i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * The platform's areas in module order: [{ area, title, path, module }].
 * From packages/catalogue/concepts.json, so a new area appears by editing
 * that file.
 */
export function platformAreas(reg = registry) {
  return Object.entries(reg.areas || {})
    .map(([area, a]) => ({ area, title: String(a.title ?? area), path: String(a.path ?? ''), module: Number(a.module) }))
    .filter((a) => Number.isFinite(a.module))
    .sort((a, b) => a.module - b.module);
}

/** The area a launcher module card stands for, or null: its path and module number match. */
export function areaForModule(path, moduleNumber, reg = registry) {
  return platformAreas(reg).find((a) => a.path === path && a.module === Number(moduleNumber)) ?? null;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Whether `selected` (option ids) is exactly the question's answer set. A
 * single-choice question is one id and a multi-choice one every correct id
 * and no other; order and repeats do not matter. Nothing chosen is never
 * correct.
 */
export function gradeQuestion(question, selected) {
  const answer = new Set(Array.isArray(question?.answer) ? question.answer : []);
  const chosen = new Set(Array.isArray(selected) ? selected : selected instanceof Set ? [...selected] : []);
  if (answer.size === 0 || chosen.size !== answer.size) return false;
  for (const id of chosen) if (!answer.has(id)) return false;
  return true;
}

/** The questions a lab asks up front: diagnostic ones (the default), in order. */
export const isDiagnostic = (q) => q && q.diagnostic !== false;

// ---------------------------------------------------------------------------
// The mastery record
// ---------------------------------------------------------------------------

/**
 * {
 *   v: 1,
 *   onboarding: { status: 'done' | 'skipped' | null, at, levels: { area: 'strong'|'ok'|'new' } },
 *   concepts:   { 'area.name': { known: boolean } },   // from lab diagnostics
 *   overrides:  { 'area.name': 'skipped' | 'forced' }
 * }
 */
export function emptyMastery() {
  return { v: 1, onboarding: { status: null, at: 0, levels: {} }, concepts: {}, overrides: {} };
}

/** Anything from storage to a well-formed record; keys and values that do not fit are dropped. */
export function normalizeMastery(raw) {
  const out = emptyMastery();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const ob = raw.onboarding;
  if (ob && typeof ob === 'object') {
    if (ob.status === 'done' || ob.status === 'skipped') out.onboarding.status = ob.status;
    if (Number.isFinite(ob.at)) out.onboarding.at = ob.at;
    if (ob.levels && typeof ob.levels === 'object') {
      for (const [area, level] of Object.entries(ob.levels)) {
        if (AREA_ID.test(area) && LEVELS.includes(level)) out.onboarding.levels[area] = level;
      }
    }
  }
  if (raw.concepts && typeof raw.concepts === 'object') {
    for (const [id, c] of Object.entries(raw.concepts)) {
      if (CONCEPT_ID.test(id) && c && typeof c === 'object' && typeof c.known === 'boolean') out.concepts[id] = { known: c.known };
    }
  }
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [id, v] of Object.entries(raw.overrides)) {
      if (CONCEPT_ID.test(id) && (v === 'skipped' || v === 'forced')) out.overrides[id] = v;
    }
  }
  return out;
}

/**
 * The record's home. `storage` defaults to window.localStorage; if it is
 * missing or throws, the record is kept in memory for this page instead.
 * get() re-reads storage each time (another tab may have written), and set()
 * never throws.
 */
export function createMasteryStore({ storage, key = STORAGE_KEY } = {}) {
  let memory = emptyMastery();
  const backend = () => {
    try {
      return storage !== undefined ? storage : (globalThis.localStorage ?? null);
    } catch {
      return null;
    }
  };
  const get = () => {
    try {
      const raw = backend()?.getItem(key);
      if (raw) memory = normalizeMastery(JSON.parse(raw));
    } catch {
      /* unreadable or blocked: the in-memory copy stands */
    }
    return memory;
  };
  const set = (m) => {
    memory = normalizeMastery(m);
    try {
      backend()?.setItem(key, JSON.stringify(memory));
    } catch {
      /* blocked or full: still right for this page */
    }
    return memory;
  };
  return { get, set, update: (fn) => set(fn(get())) };
}

// --- onboarding -------------------------------------------------------------

/** 'done', 'skipped' or null (never asked): whether the quiz should appear by itself. */
export const onboardingState = (m) => m?.onboarding?.status ?? null;
export const onboardingFinished = (m) => onboardingState(m) !== null;

/** A share of answers right to a level: most of them 'strong', half 'ok', fewer 'new'. */
export function levelFor(correct, total) {
  if (!(total > 0)) return null;
  const share = correct / total;
  if (share >= 0.85) return 'strong';
  if (share >= 0.5) return 'ok';
  return 'new';
}

/**
 * Levels per area from onboarding results ([{ question_id, concept, correct }]).
 * `questions` fixes which results count: one for a question the quiz asked.
 */
export function levelsFromOnboarding(questions, results) {
  const asked = new Map((questions || []).map((q) => [q.id, q]));
  const tally = {};
  for (const r of results || []) {
    const q = asked.get(r.question_id);
    if (!q) continue;
    const area = areaOf(q.concept);
    if (!area) continue;
    const t = (tally[area] ??= { correct: 0, total: 0 });
    t.total++;
    if (r.correct) t.correct++;
  }
  const levels = {};
  for (const [area, t] of Object.entries(tally)) {
    const level = levelFor(t.correct, t.total);
    if (level) levels[area] = level;
  }
  return levels;
}

export function recordOnboarding(m, questions, results, now = Date.now()) {
  const next = normalizeMastery(m);
  next.onboarding = { status: 'done', at: now, levels: levelsFromOnboarding(questions, results) };
  return next;
}

/** "Skip for now": remembered so the quiz does not return, but never replaces levels already earned. */
export function skipOnboarding(m, now = Date.now()) {
  const next = normalizeMastery(m);
  if (next.onboarding.status === null) next.onboarding = { status: 'skipped', at: now, levels: {} };
  return next;
}

/** 'strong' | 'ok' | 'new', or null when onboarding has not set a level for the area. */
export const areaLevel = (m, area) => m?.onboarding?.levels?.[area] ?? null;

/**
 * The first module, in the order given ([{ path, number }]), whose area's
 * level is 'new': where the launcher puts its "Suggested start" chip. Null
 * when onboarding set no level, or nothing is new.
 */
export function suggestStart(modules, m, reg = registry) {
  for (const mod of modules || []) {
    const a = areaForModule(mod.path, mod.number, reg);
    if (a && areaLevel(m, a.area) === 'new') return mod;
  }
  return null;
}

// --- lab diagnostics --------------------------------------------------------

/**
 * The diagnostic questions a lab should ask now: those whose concept the
 * learner does not already know. In the lab's own order.
 */
export function diagnosticQuestions(learn, m) {
  const known = (id) => m?.concepts?.[id]?.known === true;
  return (learn?.questions || []).filter((q) => isDiagnostic(q) && !known(q.concept));
}

/**
 * Records diagnostic results ([{ concept, correct }]). A concept is known
 * when EVERY diagnostic question asked about it was answered fully
 * correctly; one miss and it is not known (and its lesson opens).
 */
export function recordDiagnostic(m, results) {
  const next = normalizeMastery(m);
  const byConcept = new Map();
  for (const r of results || []) {
    if (!CONCEPT_ID.test(String(r.concept))) continue;
    byConcept.set(r.concept, (byConcept.get(r.concept) ?? true) && r.correct === true);
  }
  for (const [concept, allRight] of byConcept) next.concepts[concept] = { known: allRight };
  return next;
}

/** The learner's own call on a concept: 'skipped', 'forced', or null to clear it. */
export function setOverride(m, concept, value) {
  const next = normalizeMastery(m);
  if (!CONCEPT_ID.test(String(concept))) return next;
  if (value === 'skipped' || value === 'forced') next.overrides[concept] = value;
  else delete next.overrides[concept];
  return next;
}

// --- the plan ---------------------------------------------------------------

/**
 * Why a lesson starts the way it does: 'skipped' and 'forced' are the
 * learner's; 'known' is a lab diagnostic answered fully correctly; 'missed'
 * is one that was not; 'strong' is an onboarding level standing in for a
 * diagnostic not yet answered; null is no information at all.
 */
export function lessonReason(concept, m) {
  const override = m?.overrides?.[concept];
  if (override) return override;
  const diagnosed = m?.concepts?.[concept];
  if (diagnosed) return diagnosed.known ? 'known' : 'missed';
  if (areaLevel(m, areaOf(concept)) === 'strong') return 'strong';
  return null;
}

/**
 * The lesson list a lab opens with: [{ concept, state: 'expanded' | 'collapsed' }],
 * in the bundle's order.
 *
 *   forced                      expanded, whatever else is known
 *   skipped                     collapsed
 *   diagnostic: known           collapsed (recap only)
 *   diagnostic: not known       expanded, even in a 'strong' area
 *   no diagnostic, area strong  collapsed (onboarding stands in)
 *   otherwise                   expanded
 */
export function planLessons(learn, m) {
  return (learn?.concepts || []).map((c) => {
    const reason = lessonReason(c.id, m);
    const collapsed = reason === 'skipped' || reason === 'known' || reason === 'strong';
    return { concept: c.id, state: collapsed ? 'collapsed' : 'expanded' };
  });
}

// ---------------------------------------------------------------------------
// Reading what the API sent
// ---------------------------------------------------------------------------

const isStr = (v) => typeof v === 'string' && v.length > 0;
const minutesOf = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 1);

function cleanQuestion(q) {
  if (!q || typeof q !== 'object' || !isStr(q.id) || !isStr(q.concept) || !isStr(q.prompt)) return null;
  if (q.type !== 'single' && q.type !== 'multi') return null;
  const options = (Array.isArray(q.options) ? q.options : []).filter((o) => o && isStr(o.id) && isStr(o.text)).map((o) => ({ id: o.id, text: o.text }));
  const ids = new Set(options.map((o) => o.id));
  const answer = (Array.isArray(q.answer) ? q.answer : []).filter((a) => ids.has(a));
  if (options.length < 2 || answer.length === 0) return null;
  return {
    id: q.id,
    concept: q.concept,
    type: q.type,
    prompt: q.prompt,
    options,
    answer,
    explanation: typeof q.explanation === 'string' ? q.explanation : '',
    diagnostic: q.diagnostic !== false,
  };
}

function cleanField(f) {
  if (!f || typeof f !== 'object' || !/^[a-z][a-z0-9_]{0,63}$/.test(String(f.key)) || !isStr(f.prompt)) return null;
  if (f.kind !== 'text' && f.kind !== 'number' && f.kind !== 'choice') return null;
  const out = { key: f.key, prompt: f.prompt, kind: f.kind };
  if (f.kind === 'choice') {
    const choices = (Array.isArray(f.choices) ? f.choices : []).filter(isStr);
    if (choices.length < 2) return null;
    out.choices = choices;
  }
  if (isStr(f.placeholder)) out.placeholder = f.placeholder;
  if (isStr(f.help)) out.help = f.help;
  return out;
}

/**
 * GET /api/learn/:slug's body as the screens use it, or null when it is not
 * a bundle at all. Anything malformed inside (a lesson with no body, a
 * question with one option) is dropped rather than trusted, so a bad bundle
 * degrades to less content, not to a broken screen. Every list is an array.
 */
export function normalizeLearn(entry) {
  const learn = entry && typeof entry === 'object' ? entry.learn : null;
  if (!learn || typeof learn !== 'object') return null;
  const story =
    learn.story && isStr(learn.story.title) && isStr(learn.story.body)
      ? { title: learn.story.title, minutes: minutesOf(learn.story.minutes), body: learn.story.body }
      : null;
  const concepts = (Array.isArray(learn.concepts) ? learn.concepts : [])
    .filter((c) => c && CONCEPT_ID.test(String(c.id)) && isStr(c.title) && isStr(c.body))
    .map((c) => ({ id: c.id, title: c.title, minutes: minutesOf(c.minutes), recap: typeof c.recap === 'string' ? c.recap : '', body: c.body }));
  const have = new Set(concepts.map((c) => c.id));
  const questions = (Array.isArray(learn.questions) ? learn.questions : []).map(cleanQuestion).filter((q) => q && have.has(q.concept));
  const fields = (Array.isArray(learn.fields) ? learn.fields : []).map(cleanField).filter(Boolean);
  return {
    version: typeof entry.version === 'string' ? entry.version : '',
    learn: {
      version: 1,
      ...(story ? { story } : {}),
      concepts,
      questions,
      answers_file: isStr(learn.answers_file) ? learn.answers_file : 'answers.json',
      fields,
    },
  };
}

/** GET /api/onboarding's body as { intro, questions }, or null when there is nothing to ask. */
export function normalizeOnboarding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(cleanQuestion).filter(Boolean);
  if (questions.length === 0) return null;
  return { intro: typeof raw.intro === 'string' ? raw.intro : '', questions };
}

// ---------------------------------------------------------------------------
// Analytics body
// ---------------------------------------------------------------------------

/**
 * The body of POST /api/learn/answers for results ([{ question_id, concept,
 * correct }]). Exactly the API's keys and nothing that identifies anyone;
 * at most 60 answers. `slug` and `version` (a lab, for diagnostics) are left
 * out when absent, which is what the onboarding quiz sends.
 */
export function answersBody(results, { phase, slug, version } = {}) {
  const body = {};
  if (slug) body.lab_slug = slug;
  if (slug && version) body.lab_version = version;
  body.answers = (results || []).slice(0, MAX_ANSWERS).map((r) => ({
    question_id: String(r.question_id),
    concept: String(r.concept),
    correct: r.correct === true,
    phase,
  }));
  return body;
}

// ---------------------------------------------------------------------------
// Small copy helpers
// ---------------------------------------------------------------------------

/** "2 min read". */
export function readingTime(minutes) {
  const n = Math.round(Number(minutes));
  return Number.isFinite(n) && n > 0 ? `${n} min read` : '';
}
