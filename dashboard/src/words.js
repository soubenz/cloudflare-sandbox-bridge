/**
 * The console's one vocabulary: how a length of time, a count of labs, a status, a quiz answer, a skill level
 * and a plan lock are written, wherever they are drawn (the catalogue, a path, the profile, the quiz, the lab
 * page). Pure functions with no DOM, so test/unit/console-words.test.ts pins every sentence and a renderer
 * never has to word one itself.
 *
 *   time        a lab "1 h 45 min"; a path or module "About 21 h"
 *   progress    "3 of 31 labs done"
 *   status      Not started / In progress / Done / Next up / Locked
 *   quiz level  New to you / Some experience / Know it well
 *   levels      "Skill: Practitioner" for a skill, "Rank: Newcomer" for XP: never both called "level"
 *   plan lock   "Pro plan" (a chip), "This lab is included with the Pro plan." (a sentence)
 */

// ------------------------------------------------------------------ time

/**
 * Minutes as "2 h 10 min", "45 min" or "3 h". Anything that is not a positive number reads "0 min".
 * This is how a lab's length is written.
 */
export function minutesLabel(minutes) {
  const total = Math.round(Number(minutes));
  if (!Number.isFinite(total) || total <= 0) return '0 min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * A length rounded the way people say it: to five minutes under two hours, to the half hour under ten, else to
 * the hour. "21 h" for 1230 minutes. Empty when there is no time. (Callers say "About ..."; see `approxTime`.)
 */
export function approxMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 120) return minutesLabel(Math.max(5, Math.round(n / 5) * 5));
  if (n < 600) return `${Math.round(n / 30) / 2} h`;
  return `${Math.round(n / 60)} h`;
}

/** A lab's length: "1 h 45 min". Empty when the lab has no length. */
export function labTime(minutes) {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? minutesLabel(n) : '';
}

/** A path's or module's length: "About 21 h". Empty when there is no time. */
export function approxTime(minutes) {
  const approx = approxMinutes(minutes);
  return approx ? `About ${approx}` : '';
}

// ------------------------------------------------------------------ counts and progress

/** "1 lab", "31 labs". */
export const labCount = (n) => `${n} ${n === 1 ? 'lab' : 'labs'}`;

/** "1 module", "7 modules". */
export const moduleCount = (n) => `${n} ${n === 1 ? 'module' : 'modules'}`;

/** "3 of 31 labs done". */
export const labsDone = (done, total) => `${done} of ${labCount(total)} done`;

// ------------------------------------------------------------------ status

/** A lab's standing, in words: the one set every page uses. `next` and `locked` are a path step's and a lock's. */
export const STATUS_WORDS = {
  todo: 'Not started',
  started: 'In progress',
  done: 'Done',
  next: 'Next up',
  locked: 'Locked',
};

/** The word for a status key; a path step that is `upcoming` has not been started. */
export function statusWord(key) {
  if (key === 'upcoming') return STATUS_WORDS.todo;
  return STATUS_WORDS[key] ?? STATUS_WORDS.todo;
}

/** The catalogue's status filter, in the order it is drawn: [key, word]. */
export const STATUS_FILTERS = [
  ['todo', STATUS_WORDS.todo],
  ['started', STATUS_WORDS.started],
  ['done', STATUS_WORDS.done],
];

// ------------------------------------------------------------------ filters

/** The lab difficulties the catalogue knows, as the filter and the lab's chip say them. */
export const DIFFICULTY_WORDS = { intro: 'Intro', core: 'Core', advanced: 'Advanced' };

/** "intro" -> "Intro". An unknown value is capitalised as it is. */
export function difficultyWord(value) {
  return DIFFICULTY_WORDS[value] ?? capitalise(value);
}

/** "agent-foundations" -> "Agent foundations": a family as a person reads it. */
export function familyWord(value) {
  return capitalise(String(value ?? '').replace(/[-_]+/g, ' ').trim());
}

function capitalise(value) {
  const s = String(value ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ the quiz and the levels

/** What the platform quiz asks a learner to say about each skill (the stored values stay `new`, `ok`, `strong`). */
export const QUIZ_LEVELS = { new: 'New to you', ok: 'Some experience', strong: 'Know it well' };

/** The words for a stored quiz level, or '' for one that is not a quiz level. */
export const quizLevelWord = (level) => (Object.hasOwn(QUIZ_LEVELS, level) ? QUIZ_LEVELS[level] : '');

/** A skill's score level: "Skill: Practitioner" ("Not started" has no level to name, so it stays as it is). */
export const skillLevelLabel = (name) => (name === STATUS_WORDS.todo ? name : `Skill: ${name}`);

/** The learner's XP rank: "Rank: Newcomer". It is never called a level: a skill has the levels. */
export const rankLabel = (title) => `Rank: ${title}`;

// ------------------------------------------------------------------ what a finished lab earned

/** "+120 XP". */
export const xpGainText = (xp) => `+${Math.round(xp)} XP`;

/** "Skill: Retrieval 12 → 31". */
export const skillChangeText = (title, from, to) => `Skill: ${title} ${from} \u2192 ${to}`;

/** "Next lab: Trace one request". */
export const nextLabText = (title) => `Next lab: ${title}`;

// ------------------------------------------------------------------ plan locks

/** The short form, for a chip or a button's description. */
export const PLAN_LOCK_SHORT = 'Pro plan';

/** The sentence: the same one the service says (src/path/service.ts, src/router.ts). */
export const PLAN_LOCK_LONG = 'This lab is included with the Pro plan.';

/** The service's older wordings of a plan lock, still recognised in a stored path. */
export const OLD_PLAN_LOCK_WHYS = ['Included with the Pro plan.', 'Part of the paid plan', 'This lab is part of the Pro plan.'];

/** True for a `why` that is the plan lock in any wording the service has used. */
export const isPlanLockWhy = (why) => why === PLAN_LOCK_LONG || OLD_PLAN_LOCK_WHYS.includes(why);
