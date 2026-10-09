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

import { SKILLS, skillForPlacement } from './skills.js';

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
 * The areas the onboarding quiz asks about, in module order: [{ area, title, path, module }]. They are the quiz
 * skills of skills.js (packages/catalogue/paths.json, with `quiz` from concepts.json), so a title is always the
 * module's own. `skills` is for tests.
 */
export function platformAreas(skills = SKILLS) {
  return skills
    .filter((s) => s.quiz && Number.isFinite(s.module))
    .map((s) => ({ area: s.id, title: s.title, path: s.path, module: s.module }))
    .sort((a, b) => a.module - b.module);
}

/** The skill a launcher module card stands for, as { area, title, path, module }, or null. */
export function areaForModule(path, moduleNumber, skills = SKILLS) {
  const s = skillForPlacement(path, moduleNumber, skills);
  return s ? { area: s.id, title: s.title, path: s.path, module: s.module } : null;
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
  return { v: 1, onboarding: { status: null, at: 0, levels: {} }, concepts: {}, overrides: {}, labs: {} };
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
  // Labs whose "Before you begin" (story, questions, lessons) the learner has been through and started from.
  if (raw.labs && typeof raw.labs === 'object' && !Array.isArray(raw.labs)) {
    for (const [slug, v] of Object.entries(raw.labs)) {
      if (/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) && v && typeof v === 'object' && v.intro === true) out.labs[slug] = { intro: true };
    }
  }
  return out;
}

/** Whether the learner has been through this lab's "Before you begin" and started it. */
export const introSeen = (m, slug) => m?.labs?.[slug]?.intro === true;

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

// --- the adaptive probe -----------------------------------------------------

/**
 * The onboarding quiz is a branching probe, not a list. The learner ticks the
 * areas they have worked with; each ticked area gets at most two questions and
 * an unticked one gets none (it starts as 'new'):
 *
 *   basic wrong (or "Not sure")  -> 'new', stop
 *   basic right, advanced wrong  -> 'ok'
 *   basic right, advanced right  -> 'strong'
 *
 * The probe of an area is its FIRST 'basic' and its FIRST 'advanced' question
 * in the order the quiz file lists them. All of this is pure: the screen only
 * asks for the next step and feeds the answers back.
 */
export const PROBE_TIERS = ['basic', 'advanced'];
/** The most questions any one area asks. */
export const MAX_PROBE = PROBE_TIERS.length;

/** The first question of `area` at `tier`, in quiz order, leaving out the ids in `skip`; or null. */
export function probeQuestion(area, questions, tier, skip = []) {
  const skipped = new Set(skip);
  return (questions || []).find((q) => q && areaOf(q.concept) === area && q.level === tier && !skipped.has(q.id)) ?? null;
}

/** The question an area's probe opens with: its first 'basic' one not already in `asked` (ids). */
export const firstQuestionFor = (area, questions, asked = []) => probeQuestion(area, questions, 'basic', asked);

/**
 * What to do next for one area, given the answers so far (in the order asked;
 * each a boolean or { correct }; "Not sure" is simply not correct):
 *   { ask: question }  ask this one
 *   { level }          the area is settled: 'strong' | 'ok' | 'new'
 * An area with no basic question to ask cannot be judged, so it stays 'new'.
 */
export function nextStep(area, questions, answers = []) {
  const right = (a) => (a && typeof a === 'object' ? a.correct === true : a === true);
  const basic = firstQuestionFor(area, questions);
  if (!basic) return { level: 'new' };
  if (answers.length === 0) return { ask: basic };
  if (!right(answers[0])) return { level: 'new' };
  const advanced = probeQuestion(area, questions, 'advanced');
  if (!advanced) return { level: 'ok' };
  if (answers.length === 1) return { ask: advanced };
  return { level: right(answers[1]) ? 'strong' : 'ok' };
}

/**
 * The ticked areas as a list, in module order: `choice` is area ids (or
 * anything); ids that are not areas of `areas` are dropped, repeats counted once.
 */
export function orderSelected(choice, areas = platformAreas()) {
  const chosen = new Set(Array.isArray(choice) ? choice : choice instanceof Set ? [...choice] : []);
  return areas.filter((a) => chosen.has(a.area)).map((a) => a.area);
}

/**
 * Levels for EVERY area from a finished probe. `selected` is the ticked areas;
 * `results` ([{ question_id, concept, correct }]) are the answers given. An
 * unticked area is 'new' with no answers; a ticked one is replayed through
 * nextStep, so a result for a question the probe would not have asked is
 * ignored. An area whose probe was not finished gets no level.
 */
export function levelsFromProbe({ areas = platformAreas(), selected, questions, results }) {
  const ticked = new Set(selected || []);
  const levels = {};
  for (const { area } of areas) {
    if (!ticked.has(area)) {
      levels[area] = 'new';
      continue;
    }
    const answers = [];
    for (;;) {
      const step = nextStep(area, questions, answers);
      if (step.level) {
        levels[area] = step.level;
        break;
      }
      const r = (results || []).find((x) => x.question_id === step.ask.id);
      if (!r) break;
      answers.push(r);
    }
  }
  return levels;
}

/** Stores a finished quiz: `levels` is the whole { area: level } map from levelsFromProbe. */
export function recordOnboarding(m, levels, now = Date.now()) {
  const next = normalizeMastery(m);
  next.onboarding = { status: 'done', at: now, levels: { ...levels } };
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

/** Catalogue order, as the server sorts its index: (path ?? 'zz', module ?? 999, order ?? 999, slug). */
function compareCatalogue(a, b) {
  const rank = (v, none) => (Number.isFinite(v) ? v : none);
  return (
    String(a.path ?? 'zz').localeCompare(String(b.path ?? 'zz')) ||
    rank(a.module, 999) - rank(b.module, 999) ||
    rank(a.order, 999) - rank(b.order, 999) ||
    String(a.slug).localeCompare(String(b.slug))
  );
}

/**
 * The console's copy of the server's catalogue rule (src/path/next.ts), for when the profile has not answered:
 * the first lab in catalogue order that is not archived, not passed, startable (`canStart`, default every lab:
 * the console does not know the plan) and whose prerequisites in the catalogue are all passed. Null when none.
 */
export function catalogueNextLab(labs, { canStart = () => true } = {}) {
  const active = (Array.isArray(labs) ? labs : []).filter((l) => l && typeof l.slug === 'string' && l.archived !== true);
  const known = new Set(active.map((l) => l.slug));
  const passed = new Set(active.filter((l) => l.progress?.passed_all).map((l) => l.slug));
  return (
    [...active]
      .sort(compareCatalogue)
      .find((l) => !passed.has(l.slug) && canStart(l) && (l.prerequisites ?? []).every((p) => !known.has(p) || passed.has(p))) ?? null
  );
}

/**
 * Where the "Suggested start" badge goes: the module ({ path, number }) that holds the next lab. `next` is the
 * profile's `next_lab` ({ slug, path, module }): null means there is none (everything done or locked), and
 * undefined means the profile has not answered, so the console's copy of the catalogue rule stands in, over
 * `labs` (the catalogue with progress). A lab with no path places no badge.
 */
export function suggestStart(next, labs = [], opts = {}) {
  const lab = next === undefined ? catalogueNextLab(labs, opts) : next;
  if (!lab || typeof lab.path !== 'string' || !lab.path) return null;
  const n = Number(lab.module);
  return { path: lab.path, number: Number.isFinite(n) && n > 0 ? n : 1 };
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
  } else {
    // The suggested answers of a text or number field, shown as buttons beside "Something else" (questions-form.js).
    const options = (Array.isArray(f.options) ? f.options : []).filter(isStr);
    if (options.length >= 2) out.options = options;
  }
  if (isStr(f.placeholder)) out.placeholder = f.placeholder;
  if (isStr(f.help)) out.help = f.help;
  return out;
}

// --- the games of a warm-up (games.js plays them; src/labs/learn.ts GameSchema is the contract) ---

const LOCAL_ID = /^[a-z][a-z0-9-]{0,39}$/;
const isLocalId = (v) => typeof v === 'string' && LOCAL_ID.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const GAME_OPS = new Set(['*', '+', '-', '/']);
/** The entries of `list` that `clean` keeps, with no id twice. */
function cleanList(list, clean) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = clean(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function cleanSort(g) {
  const buckets = cleanList(g.buckets, (b) => (b && isLocalId(b.id) && isStr(b.label) ? { id: b.id, label: b.label } : null));
  const ids = new Set(buckets.map((b) => b.id));
  const cards = cleanList(g.cards, (c) => (c && isLocalId(c.id) && isStr(c.text) && ids.has(c.bucket) ? { id: c.id, text: c.text, bucket: c.bucket } : null));
  if (buckets.length < 2 || cards.length < 2) return null;
  return { buckets, cards };
}

function cleanFlag(g) {
  const items = cleanList(g.items, (i) =>
    i && isLocalId(i.id) && isStr(i.text) && typeof i.flag === 'boolean' ? { id: i.id, text: i.text, flag: i.flag, ...(isStr(i.why) ? { why: i.why } : {}) } : null
  );
  // Something to flag and something to leave alone, or there is no game.
  if (!items.some((i) => i.flag) || items.every((i) => i.flag)) return null;
  return { items };
}

function cleanSliders(g) {
  const inputs = cleanList(g.inputs, (i) => {
    if (!i || !isLocalId(i.id) || !isStr(i.label) || ![i.min, i.max, i.step, i.default].every(isNum)) return null;
    if (!(i.min < i.max) || !(i.step > 0) || i.default < i.min || i.default > i.max) return null;
    return { id: i.id, label: i.label, min: i.min, max: i.max, step: i.step, default: i.default, ...(isStr(i.unit) ? { unit: i.unit } : {}) };
  });
  const ids = new Set(inputs.map((i) => i.id));
  const rawFormula = Array.isArray(g.formula) ? g.formula : [];
  const formula = rawFormula.filter((f) => f && ids.has(f.input) && GAME_OPS.has(f.op)).map((f) => ({ input: f.input, op: f.op }));
  const r = g.readout;
  const a = g.ask;
  // A formula with a term dropped would compute something else: the whole game goes instead.
  if (inputs.length < 1 || formula.length < 1 || formula.length !== rawFormula.length) return null;
  if (!r || typeof r !== 'object' || !isStr(r.label) || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 6) return null;
  if (!a || typeof a !== 'object' || !isStr(a.prompt) || !ids.has(a.answer)) return null;
  return {
    inputs,
    formula,
    readout: { label: r.label, unit: isStr(r.unit) ? r.unit : '', decimals: r.decimals },
    ask: { prompt: a.prompt, answer: a.answer },
  };
}

function cleanOutline(g) {
  const steps = cleanList(g.steps, (s) =>
    s && isLocalId(s.id) && isStr(s.text) && (s.parent === null || isLocalId(s.parent)) && Number.isInteger(s.order) ? { id: s.id, text: s.text, parent: s.parent, order: s.order } : null
  );
  if (steps.length < 2 || steps.length !== (Array.isArray(g.steps) ? g.steps.length : 0)) return null;
  // One root, and every step reachable from it (no missing parent, no cycle): otherwise it cannot be solved.
  if (steps.filter((s) => s.parent === null).length !== 1) return null;
  const reached = new Set();
  const walk = (parent) => {
    for (const s of steps) {
      if (s.parent === parent && !reached.has(s.id)) {
        reached.add(s.id);
        walk(s.id);
      }
    }
  };
  walk(null);
  return reached.size === steps.length ? { steps } : null;
}

const GAME_KINDS = { sort: cleanSort, flag: cleanFlag, sliders: cleanSliders, 'order-and-nest': cleanOutline };

/** One game of a warm-up as games.js needs it, or null when anything it needs is missing or does not fit. */
export function cleanGame(g) {
  if (!g || typeof g !== 'object' || !Object.hasOwn(GAME_KINDS, g.kind)) return null;
  if (!isLocalId(g.id) || !isStr(g.title) || !isStr(g.prompt) || !isStr(g.explanation)) return null;
  const own = GAME_KINDS[g.kind](g);
  return own ? { kind: g.kind, id: g.id, title: g.title, prompt: g.prompt, explanation: g.explanation, ...own } : null;
}

/**
 * The story of an opener or a closing: `{ story?, comic?, audio? }`. The motion comic is passed through
 * whole (the player, comic.js, checks it panel by panel and falls back to the text story); its narration
 * gets the lab's slug (the API sends it beside the bundle) so the player can build the clip URLs.
 */
function cleanTelling(raw, slug) {
  const story = raw.story && isStr(raw.story.title) && isStr(raw.story.body) ? { title: raw.story.title, minutes: minutesOf(raw.story.minutes), body: raw.story.body } : null;
  const comic = raw.comic && typeof raw.comic === 'object' && isStr(raw.comic.title) && Array.isArray(raw.comic.pages) ? raw.comic : null;
  const audio =
    comic && isStr(slug) && raw.audio && typeof raw.audio === 'object' && raw.audio.clips && typeof raw.audio.clips === 'object' && Array.isArray(raw.audio.lines) ? { ...raw.audio, slug } : null;
  return { ...(story ? { story } : {}), ...(comic ? { comic } : {}), ...(audio ? { audio } : {}) };
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
  const opener = cleanTelling(learn, entry.slug);
  const concepts = (Array.isArray(learn.concepts) ? learn.concepts : [])
    .filter((c) => c && CONCEPT_ID.test(String(c.id)) && isStr(c.title) && isStr(c.body))
    .map((c) => ({ id: c.id, title: c.title, minutes: minutesOf(c.minutes), recap: typeof c.recap === 'string' ? c.recap : '', body: c.body }));
  const have = new Set(concepts.map((c) => c.id));
  const questions = (Array.isArray(learn.questions) ? learn.questions : []).map(cleanQuestion).filter((q) => q && have.has(q.concept));
  const fields = (Array.isArray(learn.fields) ? learn.fields : []).map(cleanField).filter(Boolean);
  // The closing (a warm-up's last story, after its games) has the opener's shape; one with neither a story nor a comic is none.
  const closing = learn.closing && typeof learn.closing === 'object' ? cleanTelling(learn.closing, entry.slug) : null;
  const games = cleanList(learn.games, cleanGame);
  return {
    version: typeof entry.version === 'string' ? entry.version : '',
    learn: {
      version: 1,
      ...opener,
      concepts,
      questions,
      answers_file: isStr(learn.answers_file) ? learn.answers_file : 'answers.json',
      fields,
      ...(closing && (closing.story || closing.comic) ? { closing } : {}),
      games,
    },
  };
}

/** An onboarding question: a valid question with a 'basic' or 'advanced' level, or null. */
function cleanOnboardingQuestion(q) {
  const clean = cleanQuestion(q);
  if (!clean || !PROBE_TIERS.includes(q.level)) return null;
  return { ...clean, level: q.level };
}

/**
 * GET /api/onboarding's body as { intro, questions, blurbs }, or null when
 * there is nothing to ask. `blurbs` maps an area id to its one-line
 * description. A question without a level is dropped, and a quiz with no
 * 'basic' question for any area has nothing to ask, so it is null.
 */
export function normalizeOnboarding(raw, areas = platformAreas()) {
  if (!raw || typeof raw !== 'object') return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(cleanOnboardingQuestion).filter(Boolean);
  if (!areas.some((a) => firstQuestionFor(a.area, questions))) return null;
  const blurbs = {};
  for (const a of Array.isArray(raw.areas) ? raw.areas : []) {
    if (a && isStr(a.area) && AREA_ID.test(a.area) && isStr(a.blurb)) blurbs[a.area] = a.blurb;
  }
  return { intro: typeof raw.intro === 'string' ? raw.intro : '', questions, blurbs };
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
