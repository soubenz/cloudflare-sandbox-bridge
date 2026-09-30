/**
 * The platform onboarding quiz: a screen shown once after first sign-in, and
 * again when the learner asks ("Retake the quiz" in the header, or in the
 * "?" dialog).
 *
 * It branches. The first screen asks which platform areas the learner has
 * worked with (a checklist, plus "None of these yet"); then each ticked area,
 * in module order, gets an adaptive probe of at most two questions (the
 * logic is pure and lives in learn-model.js: nextStep). An unticked area gets
 * no question and starts as 'new'.
 *
 * There is no score and no grade: the answers only set where each platform
 * module starts (strong / ok / new), which the launcher and each lab's plan
 * use as a default. "Skip for now" is on every screen and is remembered, so
 * the quiz never returns by itself; a retake that is skipped changes nothing.
 * Nothing is saved part-way: leaving mid-quiz records only the skip.
 *
 * The screen builds itself into `host`, one step at a time, moving focus to
 * the step's heading. Outcomes are posted best effort (a failure is ignored,
 * never shown, never blocks the summary).
 */

import {
  MAX_PROBE,
  answersBody,
  areaLevel,
  levelsFromProbe,
  nextStep,
  orderSelected,
  platformAreas,
  recordOnboarding,
  skipOnboarding,
} from './learn-model.js';
import { actionBar, button, focusHeading, make, questionScreen, screenHead, show } from './learn-ui.js';
import { icon, uiIcon } from './icons.js';
import { mountMarkdown } from './markdown.js';
// The copy of every path and module (icon and accent too), shared with the launcher:
// each area of the quiz is drawn with the icon and colour of the module it opens.
import pathMeta from '../../packages/catalogue/paths.json';

/** The three steps of the quiz: what you know, a question or two about it, where to start. */
const STEPS = 3;

/** The icon and accent family of the module an area belongs to (slate and a grid when the copy has none). */
function moduleLook(area) {
  const module = pathMeta.paths?.find((p) => p.slug === area.path)?.modules?.find((m) => m.number === area.module);
  return { icon: module?.icon || 'grid', accent: module?.accent || 'slate' };
}

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
 *   onboarding  { intro, questions, blurbs } from GET /api/onboarding
 *   store       the mastery store (learn-model.js createMasteryStore)
 *   post        (body) => Promise, the analytics call; errors are swallowed
 *   onExit      ({ completed }) when the learner leaves: finished, or skipped
 *   areas       the platform's areas in module order (default: concepts.json)
 * Returns { destroy }.
 */
export function runOnboarding({ host, onboarding, store, post, onExit, areas = platformAreas() }) {
  const questions = onboarding.questions || [];
  const blurbs = onboarding.blurbs || {};
  const titleOf = (area) => areas.find((a) => a.area === area)?.title ?? area;
  /** What has been answered, in order: [{ question_id, concept, correct }]. */
  const results = [];
  let selected = [];
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
  const skipButton = () => button('Skip for now', { kind: 'quiet', onClick: skip, id: 'btnOnboardingSkip' });

  /** The answers given so far for one area, in the order they were asked. */
  const answersFor = (area) => results.filter((r) => r.concept.startsWith(`${area}.`));

  // --- screen 1: what have you worked with?

  function choose() {
    const prose = make('div', 'learn-prose');
    players = mountMarkdown(prose, onboarding.intro || '', { headingLevel: 2 });

    const form = make('form', 'ob-form');
    form.noValidate = true;
    const set = make('fieldset', 'ob-set');
    set.append(make('legend', 'ob-legend', 'Pick the areas you have worked with'), make('p', 'ob-hint', 'Tick all that apply. You will only be asked about the ones you pick.'));

    const list = make('div', 'ob-choices');
    const boxes = new Map();
    // The checkbox is the real control, drawn as the design's rounded box (styles in learn.css).
    const choice = (value, title, blurb, extra = '', look = null) => {
      const label = make('label', `ob-choice${extra}`);
      const input = make('input');
      input.type = 'checkbox';
      input.name = 'area';
      input.value = value;
      boxes.set(value, input);
      const text = make('span', 'ob-choice-text');
      const head = make('span', 'ob-choice-head');
      if (look) {
        const tile = make('span', 'tile ob-choice-tile');
        tile.dataset.accent = look.accent;
        tile.setAttribute('aria-hidden', 'true');
        tile.append(icon(look.icon, 18));
        head.append(tile);
      }
      head.append(make('span', 'ob-choice-title', title));
      text.append(head);
      if (blurb) text.append(make('span', 'ob-choice-blurb', blurb));
      label.append(input, text);
      return label;
    };
    for (const a of areas) list.append(choice(a.area, a.title, blurbs[a.area], '', moduleLook(a)));
    const none = choice('none', 'None of these yet', 'I am new to all of this. Every module starts as a full lesson.', ' ob-choice-none');
    set.append(list, none);
    form.append(set);

    const message = make('p', 'ob-message');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');

    const start = button('Start', { kind: 'accent', type: 'submit', id: 'btnOnboardingStart' });
    start.classList.add('btn-lg');
    start.append(uiIcon('arrow', 16));
    // "2 areas picked": a count of what is ticked, and nothing about how many questions follow.
    const tally = make('span', 'ob-tally');
    const ticked = () => areas.filter((a) => boxes.get(a.area).checked).map((a) => a.area);
    const hasChoice = () => ticked().length > 0 || boxes.get('none').checked;
    // Not `disabled`: a disabled button cannot be reached or explained by keyboard. It says so in words instead.
    const sync = () => {
      start.setAttribute('aria-disabled', String(!hasChoice()));
      if (hasChoice()) message.textContent = '';
      const n = ticked().length;
      tally.textContent = n ? `${n} ${n === 1 ? 'area' : 'areas'} picked` : boxes.get('none').checked ? 'Every module starts as a full lesson' : 'Pick the areas you know';
    };

    // "None of these yet" is exclusive: it clears the areas, and ticking an area clears it.
    form.addEventListener('change', (event) => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement)) return;
      if (box.value === 'none' && box.checked) for (const a of areas) boxes.get(a.area).checked = false;
      else if (box.value !== 'none' && box.checked) boxes.get('none').checked = false;
      sync();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!hasChoice()) {
        message.textContent = 'Choose at least one area, or "None of these yet", then press Start.';
        return;
      }
      selected = boxes.get('none').checked ? [] : orderSelected(ticked(), areas);
      probe(0);
    });

    form.append(message, actionBar([start, skipButton(), tally]));
    sync();
    show(
      host,
      screenHead({ eyebrow: 'Welcome', title: 'What have you worked with?', mark: 'worked with?', meta: 'Nothing to pass or fail.', steps: { current: 1, total: STEPS } }),
      prose,
      form
    );
    focusHeading(host);
  }

  // --- screens 2..: one adaptive probe per ticked area

  /** Would the probe end, after this result, with no further question at all? */
  function endsAfter(ai, result) {
    const area = selected[ai];
    const step = nextStep(area, questions, [...answersFor(area), result]);
    return Boolean(step.level) && ai + 1 >= selected.length;
  }

  function probe(ai) {
    const area = selected[ai];
    if (!area) return finish();
    const answers = answersFor(area);
    const step = nextStep(area, questions, answers);
    if (!step.ask) return probe(ai + 1);
    const asked = answers.length;
    const screen = questionScreen({
      question: step.ask,
      index: asked,
      total: MAX_PROBE,
      eyebrow: `Area ${ai + 1} of ${selected.length}`,
      title: `${titleOf(area)} \u00b7 question ${asked + 1} of up to ${MAX_PROBE}`,
      allowUnsure: true,
      steps: { current: 2, total: STEPS },
      nextLabelFor: (r) => (endsAfter(ai, r) ? 'See where to start' : 'Next'),
      onNext: (r) => {
        results.push({ question_id: r.question_id, concept: r.concept, correct: r.correct });
        probe(ai);
      },
    });
    show(host, screen.root, actionBar([skipButton()], { label: 'Quiz options' }));
    focusHeading(host);
  }

  function finish() {
    const levels = levelsFromProbe({ areas, selected, questions, results });
    const next = store.update((m) => recordOnboarding(m, levels));
    // Best effort: the learner is never made to wait for, or told about, this.
    // Only what was asked is sent; "None of these yet" asked nothing, so sends nothing.
    if (results.length > 0) {
      try {
        Promise.resolve(post?.(answersBody(results, { phase: 'onboarding' }))).catch(() => {});
      } catch {
        /* analytics never blocks the summary */
      }
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
      'This only sets where each module starts. Every lab asks a few questions of its own, and you can open or skip any lesson.'
    );
    const retake = make('p', 'learn-note muted small', 'You can retake this any time from the ? menu.');
    const go = button('Go to the labs', { kind: 'accent', onClick: () => leave(true), id: 'btnOnboardingDone2' });
    go.classList.add('btn-lg');
    go.append(uiIcon('arrow', 16));
    show(
      host,
      screenHead({ eyebrow: 'Your starting point', title: 'Where to start', mark: 'start', steps: { current: 3, total: STEPS } }),
      lede,
      list,
      note,
      retake,
      actionBar([go])
    );
    focusHeading(host);
  }

  choose();
  return {
    destroy() {
      done = true;
      players?.destroy();
    },
  };
}
