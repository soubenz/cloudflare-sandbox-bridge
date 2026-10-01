/**
 * The session screen's layout decisions, with no DOM: which tabs the guide
 * has for a lab, whether it starts open, how a tab list is walked with the
 * arrow keys, and the numbers the tab badges, the rail and the dock show.
 *
 * The guide is the reading pane on the left of a running lab (Brief,
 * Questions, Checks, Hints, Solution); the workspace window is on the right.
 * The lab's story and lessons are not in it: they are read full screen
 * before the lab starts (before-you-begin.js). app.js owns the elements and
 * calls these to decide what they say.
 */

/** Below this window width the guide starts collapsed to its icon rail. */
export const GUIDE_OPEN_MIN_WIDTH = 1180;

/**
 * Whether the guide starts open for a window this wide. Asked once per lab,
 * when it starts; it is deliberately never remembered between labs.
 */
export const defaultGuideOpen = (width) => !(Number.isFinite(width) && width < GUIDE_OPEN_MIN_WIDTH);

/** Every guide tab, by id, with the words it wears. */
export const GUIDE_TABS = {
  brief: 'Brief',
  questions: 'Questions',
  checks: 'Checks',
  hints: 'Hints',
  solution: 'Solution',
};

/**
 * The tabs a lab's guide has, in order.
 *
 *   type       the lab's type from the catalogue ('explore', 'build', 'break-fix', ...)
 *   questions  it has graded questions (a form that writes the answers file)
 *   solution   the API says a solution exists
 *
 * Every lab starts with its Brief. An explore lab graded through its
 * questions has them next, and reads its checks off that tab (they grade the
 * answers), so it has no Checks tab of its own; every other lab has its
 * Checks (after its Questions, if it has those). Hints are always there (the
 * tab says when a lab has none); the Solution only when the lab has one. The
 * story and the lessons are never tabs: they are read before the lab starts.
 */
export function guideTabsFor({ type, questions = false, solution = false } = {}) {
  const tabs = ['brief'];
  if (questions) tabs.push('questions');
  if (!(questions && type === 'explore')) tabs.push('checks');
  tabs.push('hints');
  if (solution) tabs.push('solution');
  return tabs;
}

/**
 * What the dock's progress half counts: 'answers' for a lab whose guide
 * grades through the Questions tab, else 'checks'.
 */
export const dockKind = (tabs) => (tabs.includes('questions') && !tabs.includes('checks') ? 'answers' : 'checks');

/**
 * Where an arrow key moves in a row of tabs: the index to focus, or null when
 * the key is not one a tablist handles. Left/Up and Right/Down wrap around;
 * Home and End go to the ends.
 */
export function roveIndex(key, index, count) {
  if (!(count > 0)) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * The small badge on a tab and on its rail icon: `{ text, label }` or null.
 * `text` is what is drawn ("2/4"), `label` what a screen reader adds ("2 of 4
 * read"); a badge with no text still has a label (the Solution's lock).
 *
 *   questions  { answered, total }
 *   checks     { passed, count }
 *   hints      { delivered, slots }
 *   solution   { unlocked }
 */
export function tabBadge(id, c = {}) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if (id === 'questions') return n(c.total) > 0 ? { text: `${n(c.answered)}/${n(c.total)}`, label: `${n(c.answered)} of ${n(c.total)} answered` } : null;
  if (id === 'checks') return n(c.count) > 0 ? { text: `${n(c.passed)}/${n(c.count)}`, label: `${n(c.passed)} of ${n(c.count)} passing` } : null;
  if (id === 'hints') return n(c.slots) > 0 ? { text: `${n(c.delivered)}/${n(c.slots)}`, label: `${n(c.delivered)} of ${n(c.slots)} shown` } : null;
  if (id === 'solution') return c.unlocked === undefined ? null : c.unlocked ? { text: 'Ready', label: 'unlocked' } : { text: '', label: 'locked' };
  return null;
}

/** The accessible name of a tab's rail icon: "Questions, 2 of 3 answered". */
export const railLabel = (id, badge) => `${GUIDE_TABS[id] ?? id}${badge?.label ? `, ${badge.label}` : ''}`;

/**
 * The dots of the dock and the header tag, one per check: 'p' passed, 'f'
 * failed, 'o' not run. `results` are the latest run's ({pass}); `planned` is
 * how many checks the lab has (from the manifest), so the dots are there,
 * open, before the first run.
 */
export function checkDots(results, planned = 0) {
  const run = Array.isArray(results) ? results : [];
  if (run.length) return run.map((r) => (r && r.pass ? 'p' : 'f'));
  return Array.from({ length: Math.max(0, Math.min(Number(planned) || 0, 12)) }, () => 'o');
}

/** One dot per question: 'p' for one with an answer, 'o' for one without. */
export const answerDots = (answered, total) =>
  Array.from({ length: Math.max(0, Math.min(Number(total) || 0, 12)) }, (_, i) => (i < (Number(answered) || 0) ? 'p' : 'o'));

/**
 * How the dock names the next hint. `locked` are the milliseconds until each
 * hint that is still locked (by the server's clock; null when that is not
 * known yet) and `slots` is how many hints the lab has. Empty when the lab has
 * no hints at all.
 */
export function hintCountdown({ locked = [], slots = 0 } = {}) {
  if (!(slots > 0)) return '';
  const known = locked.filter((ms) => Number.isFinite(ms));
  if (!locked.length) return slots === 1 ? 'The hint is shown' : `All ${slots} hints shown`;
  if (!known.length) return 'Hints unlock as you go';
  const ms = Math.min(...known);
  if (ms <= 0) return 'Next hint unlocking now';
  if (ms < 60_000) return 'Next hint in under 1 min';
  const m = Math.ceil(ms / 60_000);
  const h = Math.floor(m / 60);
  return `Next hint in ${h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`}`;
}

/**
 * The dock's one primary button. A lab graded through its questions says
 * "Answer questions" (and takes the learner to them) until every question has
 * an answer, then "Check my answers", which runs the checks; any other lab
 * runs its checks. `action` is what pressing it does: 'questions' or 'checks'.
 */
export function dockAction({ kind, answered = 0, total = 0 } = {}) {
  if (kind === 'answers') {
    return total > 0 && answered < total ? { label: 'Answer questions', action: 'questions' } : { label: 'Check my answers', action: 'checks' };
  }
  return { label: 'Run checks', action: 'checks' };
}

/** The text beside the dock's dots: "2 of 3 answered", "2 of 3 checks passing", "Checks not run yet". */
export function dockProgressText({ kind, answered = 0, total = 0, passed = 0, count = 0, planned = 0 } = {}) {
  if (kind === 'answers') return total > 0 ? `${answered} of ${total} answered` : 'No questions';
  if (count > 0) return `${passed} of ${count} checks passing`;
  return planned > 0 ? `${planned} ${planned === 1 ? 'check' : 'checks'} to pass` : 'Checks not run yet';
}

/**
 * The window's title: the open file when the Editor is showing one, else the
 * name of the view.
 */
export function windowTitle({ view, file, service }) {
  if (view === 'editor') return file || 'Editor';
  if (view === 'service') return service || 'Service';
  return 'Terminal';
}
