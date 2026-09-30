/**
 * The platform onboarding quiz: a screen shown once after first sign-in, and
 * again when the learner asks ("Retake the quiz" in the header).
 *
 * It has no score and no grade: its answers only set where each platform
 * module starts (strong / ok / new), which the launcher and each lab's plan
 * use as a default. "Skip for now" is on every screen and is remembered, so
 * the quiz never returns by itself; a retake that is skipped changes nothing.
 *
 * The screen builds itself into `host`, one step at a time, moving focus to
 * the step's heading. Outcomes are posted best effort (a failure is ignored,
 * never shown, never blocks the summary).
 */

import { answersBody, areaLevel, platformAreas, recordOnboarding, skipOnboarding } from './learn-model.js';
import { actionBar, button, focusHeading, make, questionScreen, screenHead, show } from './learn-ui.js';
import { mountMarkdown } from './markdown.js';

/** What a level chip says. Words about knowledge, never about marks. */
export const LEVEL_LABELS = { strong: 'Strong', ok: 'Familiar', new: 'New' };

/** One line per module, by level. The "new" one is the suggestion to start there. */
export function levelLine(level, moduleNumber) {
  if (level === 'strong') return `Module ${moduleNumber} starts as short recaps. Open any lesson you want in full.`;
  if (level === 'ok') return `Some of module ${moduleNumber} is familiar. Its lessons open, and each lab's own questions can shorten them.`;
  return `Start with module ${moduleNumber}. Its lessons open in full.`;
}

/**
 * The summary as data: [{ area, title, module, level, line }] in module order,
 * and `start`, the first module at level 'new' (or null).
 */
export function summarise(mastery, areas = platformAreas()) {
  const rows = areas.map((a) => {
    const level = areaLevel(mastery, a.area) ?? 'new';
    return { area: a.area, title: a.title, module: a.module, level, line: levelLine(level, a.module) };
  });
  return { rows, start: rows.find((r) => r.level === 'new') ?? null };
}

/**
 * Runs the quiz in `host`.
 *   onboarding  { intro, questions } from GET /api/onboarding
 *   store       the mastery store (learn-model.js createMasteryStore)
 *   post        (body) => Promise, the analytics call; errors are swallowed
 *   onExit      ({ completed }) when the learner leaves: finished, or skipped
 * Returns { destroy }.
 */
export function runOnboarding({ host, onboarding, store, post, onExit }) {
  const questions = onboarding.questions || [];
  const results = [];
  let players = null;
  let done = false;

  const leave = (completed) => {
    if (done) return;
    done = true;
    players?.destroy();
    onExit?.({ completed });
  };

  const skip = () => {
    store.update((m) => skipOnboarding(m));
    leave(false);
  };
  const skipButton = () => button('Skip for now', { kind: 'ghost', onClick: skip, id: 'btnOnboardingSkip' });

  function intro() {
    const prose = make('div', 'learn-prose');
    players = mountMarkdown(prose, onboarding.intro || '', { headingLevel: 2 });
    const start = button('Start the quiz', { kind: 'primary', onClick: () => question(0), id: 'btnOnboardingStart' });
    show(
      host,
      screenHead({
        eyebrow: 'Welcome',
        title: 'Find your starting point',
        meta: `${questions.length} questions. Nothing to pass or fail.`,
      }),
      prose,
      actionBar([start, skipButton()])
    );
    focusHeading(host);
  }

  function question(i) {
    const q = questions[i];
    if (!q) return finish();
    const step = questionScreen({
      question: q,
      index: i,
      total: questions.length,
      lastLabel: 'See where to start',
      onNext: (r) => {
        results.push(r);
        question(i + 1);
      },
    });
    show(host, step.root, actionBar([skipButton()], { label: 'Quiz options' }));
    focusHeading(host);
  }

  function finish() {
    const next = store.update((m) => recordOnboarding(m, questions, results));
    // Best effort: the learner is never made to wait for, or told about, this.
    try {
      Promise.resolve(post?.(answersBody(results, { phase: 'onboarding' }))).catch(() => {});
    } catch {
      /* analytics never blocks the summary */
    }
    summary(next);
  }

  function summary(mastery) {
    const { rows, start } = summarise(mastery);
    const lede = make(
      'p',
      'learn-lede',
      start ? `Start with module ${start.module}, ${start.title}.` : 'You can start with any module.'
    );
    const list = make('ul', 'level-list');
    for (const r of rows) {
      const li = make('li', 'level-row');
      li.dataset.area = r.area;
      li.dataset.level = r.level;
      const top = make('div', 'level-top');
      top.append(make('span', 'level-module', `Module ${r.module}`), make('span', 'level-title', r.title));
      const chip = make('span', 'chip level-chip', LEVEL_LABELS[r.level]);
      chip.dataset.level = r.level;
      top.append(chip);
      li.append(top, make('p', 'level-line', r.line));
      list.append(li);
    }
    const note = make(
      'p',
      'learn-note muted small',
      'This only sets where each module starts. Every lab asks a few questions of its own, and you can open or skip any lesson. You can retake this quiz from the header.'
    );
    const go = button('Go to the labs', { kind: 'primary', onClick: () => leave(true), id: 'btnOnboardingDone2' });
    show(host, screenHead({ eyebrow: 'Your starting point', title: 'Where to start' }), lede, list, note, actionBar([go]));
    focusHeading(host);
  }

  intro();
  return {
    destroy() {
      done = true;
      players?.destroy();
    },
  };
}
