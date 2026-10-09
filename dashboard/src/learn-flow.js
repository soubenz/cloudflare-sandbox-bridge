/**
 * The order of "Before you begin", with no DOM: which steps a lab's pre-lab
 * flow has and what each one holds.
 *
 *   story -> Round 1 (questions) -> lessons, part 1 -> Round 2 -> lessons, part 2 -> Round 3 ... -> Start the lab
 *
 * The questions and the lessons alternate, so a learner is never asked more than a handful of
 * things in a row and never reads more than a few lessons before being asked again. Every rule
 * lives in `planLearningFlow(learn, mastery)`; before-you-begin.js only draws the steps it returns.
 *
 * The rules:
 *   - A round holds at most 5 questions. The rounds are the questions in fives; when the last would
 *     hold only 1 or 2, they are folded into the others (a round then holds up to 6, never more). A
 *     round with no questions is not a step. No question is asked twice.
 *   - Round 1 draws diagnostic questions, one concept after another in lesson order (the foundation
 *     lesson's concept first) and round and round again, so every concept is asked about before any is
 *     asked about twice. Its answers set the mastery record exactly as the old single block did.
 *   - The lessons are cut, in lesson order, into min(lessons, rounds - 1) chunks of as even a size as
 *     possible, the foundation lesson in the first. Each chunk is followed by a round drawn from the
 *     questions about ITS concepts (the ones that are not diagnostic included) not yet asked; the last
 *     round also takes what the earlier ones left over.
 *   - A lab with 5 questions or fewer asks them in one round, then shows all its lessons as one chunk.
 *   - A concept the learner already knows (from an earlier visit) is not asked about at all.
 *
 * A step is one of
 *   { kind: 'story' }
 *   { kind: 'round',   round, rounds, questions: [question id] }
 *   { kind: 'lessons', part, parts, concepts: [concept id], plan: [{ concept, state }] }
 * where `plan` is how the lessons would start now (the screen asks again when it opens, because
 * Round 1 changes it). Steps are plain data: they can be saved and read back.
 */

import { isDiagnostic, planLessons } from './learn-model.js';

/** The most questions a round normally holds. */
export const ROUND_SIZE = 5;
/** The most it ever holds, when a tiny last round is folded in. */
export const MAX_ROUND = 6;

/**
 * How many questions each round may hold for `total` questions: fives, and when the last would
 * hold only one or two they are folded in and the rounds are evened out (12 is 6 and 6, never
 * 5 and 7). The last round may take up to MAX_ROUND, for the leftovers of the others.
 */
export function roundCaps(total) {
  if (!(total > 0)) return [];
  let rounds = Math.ceil(total / ROUND_SIZE);
  const last = total - ROUND_SIZE * (rounds - 1);
  let even = false;
  if (rounds > 1 && last <= 2) {
    // A last round of one or two is folded into the others when that stays within MAX_ROUND; 7 cannot be, and is 4 and 3.
    if (Math.ceil(total / (rounds - 1)) <= MAX_ROUND) rounds -= 1;
    even = true;
  }
  const base = Math.floor(total / rounds);
  const extra = total % rounds;
  const caps = Array.from({ length: rounds }, (_, i) => (even ? base + (i < extra ? 1 : 0) : ROUND_SIZE));
  // The last round also takes what the earlier ones could not hold.
  caps[rounds - 1] = MAX_ROUND;
  return caps;
}

/** `n` lessons in `chunks` runs of as even a size as possible, the earlier runs the longer: 5 in 2 is 3 and 2. */
export function chunkSizes(n, chunks) {
  if (!(n > 0) || !(chunks > 0)) return [];
  const count = Math.min(n, chunks);
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The questions in turns: one of each concept (in `order`), then the second of each, and so on, up to `cap`. */
function roundRobin(questions, order, cap) {
  const byConcept = new Map(order.map((id) => [id, []]));
  for (const q of questions) {
    if (!byConcept.has(q.concept)) byConcept.set(q.concept, []);
    byConcept.get(q.concept).push(q);
  }
  const queues = [...byConcept.values()].filter((l) => l.length > 0);
  const out = [];
  for (let turn = 0; out.length < cap; turn++) {
    let any = false;
    for (const queue of queues) {
      if (turn < queue.length) {
        any = true;
        out.push(queue[turn]);
        if (out.length >= cap) break;
      }
    }
    if (!any) break;
  }
  return out;
}

/**
 * The flow of a lab: the ordered steps (see the top of this file), from its learn bundle and the
 * learner's mastery record. Deterministic: the same inputs give the same steps.
 */
export function planLearningFlow(learn, mastery) {
  const concepts = (learn?.concepts || []).map((c) => c.id);
  const known = (id) => mastery?.concepts?.[id]?.known === true;
  // Questions of a concept the learner already knows are not asked again.
  const pool = (learn?.questions || []).filter((q) => q && !known(q.concept));
  const order = [...concepts];
  for (const q of pool) if (!order.includes(q.concept)) order.push(q.concept);

  const hasStory = Boolean(learn?.story || learn?.comic);
  const caps = roundCaps(pool.length);
  const rounds = caps.length;
  const chunkCount = concepts.length === 0 ? 0 : rounds >= 2 ? Math.min(concepts.length, rounds - 1) : 1;
  const sizes = chunkSizes(concepts.length, chunkCount);
  const chunks = [];
  let at = 0;
  for (const size of sizes) {
    chunks.push(concepts.slice(at, at + size));
    at += size;
  }

  const asked = new Set();
  const take = (list, cap) => {
    const picked = roundRobin(
      list.filter((q) => !asked.has(q.id)),
      order,
      cap
    );
    for (const q of picked) asked.add(q.id);
    return picked.map((q) => q.id);
  };

  // The question ids of every round slot: slot 0 before the lessons, slot i after chunk i, any more at the end.
  const slots = [];
  for (let s = 0; s < rounds; s++) {
    const last = s === rounds - 1;
    let ids;
    if (s === 0) {
      // A lab asked in one round has no later one for the questions that are not diagnostic: they come along.
      ids = take(rounds === 1 ? pool : pool.filter(isDiagnostic), caps[0]);
    } else if (s <= chunks.length) {
      const own = new Set(chunks[s - 1]);
      ids = take(
        pool.filter((q) => own.has(q.concept)),
        caps[s]
      );
      if (last && ids.length < caps[s]) ids.push(...take(pool, caps[s] - ids.length));
    } else {
      ids = take(pool, caps[s]);
    }
    slots.push(ids);
  }

  const lessonStep = (ids) => ({ kind: 'lessons', part: 0, parts: 0, concepts: ids, plan: planLessons({ concepts: ids.map((id) => ({ id })) }, mastery) });
  const raw = [];
  if (hasStory) raw.push({ kind: 'story' });
  const round = (ids) => ({ kind: 'round', round: 0, rounds: 0, questions: ids });
  if (slots[0]) raw.push(round(slots[0]));
  for (let i = 0; i < chunks.length; i++) {
    raw.push(lessonStep(chunks[i]));
    if (rounds >= 2 && slots[i + 1]) raw.push(round(slots[i + 1]));
  }
  for (let s = chunks.length + 1; s < rounds; s++) raw.push(round(slots[s]));

  // A round with no questions is skipped, and the lessons either side of it are then one screen.
  const steps = [];
  for (const step of raw) {
    if (step.kind === 'round' && step.questions.length === 0) continue;
    const prev = steps[steps.length - 1];
    if (step.kind === 'lessons' && prev?.kind === 'lessons') {
      const ids = [...prev.concepts, ...step.concepts];
      steps[steps.length - 1] = lessonStep(ids);
    } else {
      steps.push(step);
    }
  }
  const roundSteps = steps.filter((s) => s.kind === 'round');
  const lessonSteps = steps.filter((s) => s.kind === 'lessons');
  roundSteps.forEach((s, i) => {
    s.round = i + 1;
    s.rounds = roundSteps.length;
  });
  lessonSteps.forEach((s, i) => {
    s.part = i + 1;
    s.parts = lessonSteps.length;
  });
  return steps;
}

/**
 * The flow of a warm-up: the lab's flow (above), then one step per game in the bundle's order
 *   { kind: 'game', game: id }
 * and, when the bundle has a closing, its story last
 *   { kind: 'story', closing: true }
 */
export function planWarmUpFlow(learn, mastery) {
  const steps = planLearningFlow(learn, mastery);
  for (const g of learn?.games || []) if (g && typeof g.id === 'string') steps.push({ kind: 'game', game: g.id });
  if (learn?.closing) steps.push({ kind: 'story', closing: true });
  return steps;
}

// ---------------------------------------------------------------------------
// Reading the steps
// ---------------------------------------------------------------------------

/** What the step is called to a screen reader: "Questions, round 2 of 3", "Lessons, part 1 of 2", a game's title. */
export function stepLabel(step, learn) {
  if (!step) return '';
  if (step.kind === 'story' && step.closing) return learn?.closing?.story?.title ?? learn?.closing?.comic?.title ?? 'The closing story';
  if (step.kind === 'story') return learn?.story?.title ?? learn?.comic?.title ?? 'The story';
  if (step.kind === 'round') return step.rounds > 1 ? `Questions, round ${step.round} of ${step.rounds}` : 'Questions';
  if (step.kind === 'game') return (learn?.games || []).find((g) => g.id === step.game)?.title ?? 'A game';
  return step.parts > 1 ? `Lessons, part ${step.part} of ${step.parts}` : 'Lessons';
}

/** The heading of question `index` (0-based) of a round: "Round 2 of 3 · question 3 of 5", or "Question 3 of 5" when it is the only round. */
export function questionHeading(step, index) {
  const of = `question ${index + 1} of ${step.questions.length}`;
  return step.rounds > 1 ? `Round ${step.round} of ${step.rounds} · ${of}` : `Question ${index + 1} of ${step.questions.length}`;
}

/**
 * The index of the step an address names, or 0 (the first step) when it names none. `kind` is the
 * path's word ('story', 'questions', 'lessons', and for a warm-up 'games' and 'closing') and `n` the
 * 1-based `?step=` number, if any. A number in range wins whatever the word says; one out of range is
 * the first step; without a number the word names the first step of its kind ('games' the first game,
 * 'closing' the closing story), and a kind this lab does not have falls to the first step of the
 * closest one it does.
 */
export function stepIndexFor(steps, kind, n) {
  if (!steps.length) return 0;
  if (n !== undefined && n !== null) return Number.isInteger(n) && n >= 1 && n <= steps.length ? n - 1 : 0;
  const find = (k) => steps.findIndex((s) => stepKindWord(s) === k);
  const near = { questions: ['lessons'], lessons: ['questions'], games: ['closing'], closing: ['games'] };
  for (const k of [kind, ...(near[kind] ?? [])]) {
    const i = find(k);
    if (i >= 0) return i;
  }
  return 0;
}

/** The path word of a step, as the address spells it: a round is 'questions', a game 'games', the closing story 'closing'. */
export const stepKindWord = (step) => (step.kind === 'round' ? 'questions' : step.kind === 'game' ? 'games' : step.kind === 'story' && step.closing ? 'closing' : step.kind);

/**
 * The address's step number for a step: its 1-based position, or null when the path word alone
 * already means this step (the first of its kind), so simple labs keep the plain /story, /questions and /lessons.
 */
export function stepNumberFor(steps, index) {
  const step = steps[index];
  if (!step) return null;
  const word = stepKindWord(step);
  return steps.findIndex((s) => stepKindWord(s) === word) === index ? null : index + 1;
}

// ---------------------------------------------------------------------------
// When to warm the lab up
// ---------------------------------------------------------------------------

/**
 * The index of the step at which the lab's container is prepared in the background, so that Start
 * on the last step is instant: the second-to-last step (the one before the final lessons or
 * questions, the screen that holds "Start the lab"). A flow of one step prepares when that step is
 * shown, and an empty flow never prepares (-1). Pure; the screen asks `shouldPrefetch`.
 */
export function prefetchStepIndex(steps) {
  const n = Array.isArray(steps) ? steps.length : 0;
  if (n === 0) return -1;
  return n >= 2 ? n - 2 : 0;
}

/**
 * Whether showing step `index` is a reason to prepare the lab: it is the prefetch step or a later
 * one (a refresh or a link can land straight on the last step, which skips past the prefetch one).
 * The screen asks once per visit and acts on the first yes, so Back and Forward never prepare twice.
 */
export function shouldPrefetch(steps, index) {
  const at = prefetchStepIndex(steps);
  return at >= 0 && Number.isInteger(index) && index >= at;
}

/**
 * Steps saved by an earlier page of the same visit, checked against the bundle: every question and
 * concept they name must still exist. Anything else is null (a fresh plan is made instead). A warm-up's
 * game the bundle no longer has, or a closing it no longer has, is dropped and the rest kept.
 */
export function restoreSteps(learn, saved) {
  if (!Array.isArray(saved) || saved.length === 0) return null;
  const questions = new Set((learn?.questions || []).map((q) => q.id));
  const concepts = new Set((learn?.concepts || []).map((c) => c.id));
  const games = new Set((learn?.games || []).map((g) => g.id));
  const out = [];
  for (const s of saved) {
    if (!s || typeof s !== 'object') return null;
    if (s.kind === 'story' && s.closing === true) {
      if (learn?.closing) out.push({ kind: 'story', closing: true });
    } else if (s.kind === 'game') {
      if (typeof s.game === 'string' && games.has(s.game)) out.push({ kind: 'game', game: s.game });
    } else if (s.kind === 'story') {
      out.push({ kind: 'story' });
    } else if (s.kind === 'round') {
      if (!Array.isArray(s.questions) || s.questions.length === 0 || !s.questions.every((id) => questions.has(id))) return null;
      out.push({ kind: 'round', round: Number(s.round) || 0, rounds: Number(s.rounds) || 0, questions: [...s.questions] });
    } else if (s.kind === 'lessons') {
      if (!Array.isArray(s.concepts) || s.concepts.length === 0 || !s.concepts.every((id) => concepts.has(id))) return null;
      out.push({ kind: 'lessons', part: Number(s.part) || 0, parts: Number(s.parts) || 0, concepts: [...s.concepts], plan: Array.isArray(s.plan) ? s.plan : [] });
    } else {
      return null;
    }
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Where a visit is kept, so a refresh comes back to the same step
// ---------------------------------------------------------------------------

/**
 * One lab's visit in this tab: the steps it was planned with and the answers given so far.
 * Planned once and kept because the plan depends on the mastery record, which Round 1 changes: a
 * refresh that planned again would find the first round's concepts known and ask something else.
 * Kept in sessionStorage (this tab only; storage that is blocked or throws means a refresh plans
 * again, nothing worse). `version` is the bundle's: another version is another plan.
 *
 *   { v: 1, version, steps, answers: { [question id]: { question_id, concept, correct, selected } },
 *     games?: { [game id]: { id, tries } }, started_at?: ms }
 *
 * `games` (the warm-up games solved so far) and `started_at` (when the warm-up was opened) are a
 * warm-up's only: a refresh keeps the games solved and the time it began.
 */
export function createFlowStore({ slug, version = '', storage } = {}) {
  const key = `opalix.flow.${slug}`;
  const backend = () => {
    try {
      return storage !== undefined ? storage : (globalThis.sessionStorage ?? null);
    } catch {
      return null;
    }
  };
  return {
    load() {
      try {
        const raw = backend()?.getItem(key);
        const rec = raw ? JSON.parse(raw) : null;
        if (!rec || rec.v !== 1 || rec.version !== version || !Array.isArray(rec.steps)) return null;
        const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        return {
          steps: rec.steps,
          answers: record(rec.answers),
          games: record(rec.games),
          ...(Number.isFinite(rec.started_at) && rec.started_at > 0 ? { started_at: rec.started_at } : {}),
        };
      } catch {
        return null;
      }
    },
    save(steps, answers, { games, started_at } = {}) {
      try {
        backend()?.setItem(key, JSON.stringify({ v: 1, version, steps, answers, ...(games ? { games } : {}), ...(started_at ? { started_at } : {}) }));
      } catch {
        /* blocked or full: the visit just cannot be resumed */
      }
    },
    clear() {
      try {
        backend()?.removeItem(key);
      } catch {
        /* nothing to clear */
      }
    },
  };
}
