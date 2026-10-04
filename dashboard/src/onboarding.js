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
import { buildRoute } from './routes.js';
import { icon, uiIcon } from './icons.js';
import { mountMarkdown } from './markdown.js';
import { goalKindField, hoursField, loadGoal } from './goal-fields.js';
// The copy of every path and module (icon and accent too), shared with the launcher:
// each area of the quiz is drawn with the icon and colour of the module it opens.
import pathMeta from '../../packages/catalogue/paths.json';

/** The steps of the quiz: what you know, a question or two about it, your goal, where to start. */
const STEPS = 4;

/** The icon and accent family of the module an area belongs to (slate and a grid when the copy has none). */
function moduleLook(area) {
  const module = pathMeta.paths?.find((p) => p.slug === area.path)?.modules?.find((m) => m.number === area.module);
  return { icon: module?.icon || 'grid', accent: module?.accent || 'slate' };
}

/** What the summary says about an area, by level. Words about knowledge, never about marks. */
export const LEVEL_LABELS = { strong: 'You know this well', ok: 'You have some experience', new: 'New to you' };

/** Why the "Start here" card suggests its area, in the learner's own terms, by that area's level. */
export const START_REASONS = {
  new: 'You said this is new to you, so we begin here.',
  ok: 'You know part of this already — a good place to build on.',
  strong: 'You know all of this well. Pick the area you want to sharpen.',
};

/** A goal in words, for the recap line. */
const GOAL_WORDS = { 'role-ready': 'be ready for a role', 'specific-skill': 'learn one skill', explore: 'explore' };

/**
 * "Your goal: Run our gateway · about 4 hours a week" from { goal_kind, goal_text, hours_per_week }.
 * The learner's own words win over the kind; an empty string when there is no goal object.
 */
export function goalLine(goal) {
  if (!goal || typeof goal !== 'object') return '';
  const text = typeof goal.goal_text === 'string' ? goal.goal_text.replace(/\s+/g, ' ').trim() : '';
  const what = text || GOAL_WORDS[goal.goal_kind] || GOAL_WORDS.explore;
  const n = Number(goal.hours_per_week);
  const hours = Number.isFinite(n) && n > 0 ? ` · about ${n} ${n === 1 ? 'hour' : 'hours'} a week` : '';
  return `Your goal: ${what}${hours}`;
}

/**
 * The summary as data. `rows` is [{ area, title, path, module, level, phrase }] in module order; `start` is
 * the one area to begin with, or null when there are no areas: the first that is new, else the first that is
 * familiar, else (everything strong) the first, with `why` saying so in the learner's terms.
 */
export function summarise(mastery, areas = platformAreas()) {
  const rows = areas.map((a) => {
    const level = areaLevel(mastery, a.area) ?? 'new';
    return { area: a.area, title: a.title, path: a.path, module: a.module, level, phrase: LEVEL_LABELS[level] };
  });
  const pick = rows.find((r) => r.level === 'new') ?? rows.find((r) => r.level === 'ok') ?? rows[0] ?? null;
  return { rows, start: pick && { ...pick, why: START_REASONS[pick.level] } };
}

/**
 * Runs the quiz in `host`.
 *   onboarding  { intro, questions, blurbs } from GET /api/onboarding
 *   store       the mastery store (learn-model.js createMasteryStore)
 *   post        (body) => Promise, the analytics call; errors are swallowed
 *   onExit      ({ completed, to? }) when the learner leaves: finished, or skipped. `to` is a page the
 *               learner chose on the last screen ({ name: 'module', params: { path, module } } or
 *               { name: 'my-path', params: {} }), always one buildRoute accepts; without it, home.
 *   areas       the platform's areas in module order (default: concepts.json)
 *   onGoal      ({ levels, goal }) => Promise, called once the two last questions are answered (or skipped,
 *               with what was filled in): `levels` is the whole { area: level } result, `goal` is
 *               { goal_kind, goal_text, hours_per_week }. Errors are swallowed: the path is simply not shown.
 *               Without it the quiz ends after the probes, as it did before paths.
 *   initialGoal what the two last questions start from (default: what was answered last time)
 * Returns { destroy }.
 */
export function runOnboarding({ host, onboarding, store, post, onExit, onGoal, initialGoal, areas = platformAreas() }) {
  const questions = onboarding.questions || [];
  const blurbs = onboarding.blurbs || {};
  const titleOf = (area) => areas.find((a) => a.area === area)?.title ?? area;
  /** What has been answered, in order: [{ question_id, concept, correct }]. */
  const results = [];
  let selected = [];
  let players = null;
  let done = false;

  const leave = (completed, to) => {
    if (done) return;
    done = true;
    players?.destroy();
    onExit?.(to ? { completed, to } : { completed });
  };

  /** Leaves the quiz for a page. A route that cannot be spelled falls back to the labs list. */
  const leaveTo = (name, params = {}) => {
    try {
      buildRoute(name, params);
    } catch {
      return leave(true);
    }
    leave(true, { name, params });
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
      nextLabelFor: (r) => (endsAfter(ai, r) ? (onGoal ? 'Next: your goal' : 'See where to start') : 'Next'),
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
    if (!onGoal) return summary(next, levels);
    goal = { ...(initialGoal ?? loadGoal()) };
    goalQuestion(levels, next);
  }

  // --- the two last questions: what are you aiming for, and how many hours a week

  /** What the two last questions hold so far: it survives going Back, and is what Skip sends. */
  let goal = null;

  /**
   * Sends what was answered (best effort: the learner is never made to wait for it, or told it failed), then the
   * summary. The summary offers "See my personal path" once the save has settled well, and never mentions a failure.
   */
  function sendGoal(levels, mastery) {
    let saved;
    try {
      saved = Promise.resolve(onGoal({ levels, goal: { ...goal } })).then(
        () => true,
        () => false
      );
    } catch {
      saved = Promise.resolve(false);
    }
    summary(mastery, levels, saved);
  }

  const skipGoalButton = (levels, mastery, id) =>
    button('Skip these questions', { kind: 'quiet', onClick: () => sendGoal(levels, mastery), id });

  function goalQuestion(levels, mastery) {
    const field = goalKindField({ initial: goal, legend: 'What are you aiming for?', legendClass: 'sr-only' });
    const form = make('form', 'ob-form');
    form.noValidate = true;
    const next = button('Next', { kind: 'accent', type: 'submit', id: 'btnGoalNext' });
    next.classList.add('btn-lg');
    next.append(uiIcon('arrow', 16));
    form.append(field.root, actionBar([next, skipGoalButton(levels, mastery, 'btnGoalSkip')]));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      goal = { ...goal, ...field.value() };
      hoursQuestion(levels, mastery);
    });
    show(
      host,
      screenHead({ eyebrow: 'Your path · question 1 of 2', title: 'What are you aiming for?', mark: 'aiming for?', meta: 'This shapes the labs we line up for you.', steps: { current: 3, total: STEPS } }),
      form
    );
    focusHeading(host);
  }

  function hoursQuestion(levels, mastery) {
    const field = hoursField({ initial: goal, legend: 'How many hours a week can you give this?', legendClass: 'sr-only' });
    const form = make('form', 'ob-form');
    form.noValidate = true;
    const done = button('See where to start', { kind: 'accent', type: 'submit', id: 'btnHoursNext' });
    done.classList.add('btn-lg');
    done.append(uiIcon('arrow', 16));
    const back = button('Back', { kind: 'quiet', onClick: () => goalQuestion(levels, mastery), id: 'btnHoursBack' });
    form.append(field.root, actionBar([done, back, skipGoalButton(levels, mastery, 'btnHoursSkip')]));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!field.validate()) return;
      goal = { ...goal, hours_per_week: field.value() };
      sendGoal(levels, mastery);
    });
    show(
      host,
      screenHead({ eyebrow: 'Your path · question 2 of 2', title: 'How many hours a week can you give this?', mark: 'can you give this?', meta: 'A rough number is fine. It sets how long your path is expected to take.', steps: { current: 3, total: STEPS } }),
      form
    );
    focusHeading(host);
  }

  /**
   * The last screen: the one area to start with (and why, from the learner's own answer), what they said about
   * the goal, a quiet list of what they told us, and a way on. `saved` settles true when the path was saved.
   * No module numbers: the learner knows the areas by their names.
   */
  function summary(mastery, levels, saved) {
    const { rows, start } = summarise(mastery);
    const nodes = [screenHead({ eyebrow: 'Your starting point', title: 'Where to start', mark: 'start', steps: { current: STEPS, total: STEPS, done: true } })];
    const open = (row) => leaveTo('module', { path: row.path, module: row.module });

    // The personal path is offered once it has been saved; if saving failed it is never shown.
    let seePath = null;
    if (onGoal && saved) {
      seePath = button('See my personal path', { kind: 'ghost', onClick: () => leaveTo('my-path'), id: 'btnSeeMyPath' });
      seePath.classList.add('btn-lg');
      seePath.hidden = true;
      saved.then((ok) => {
        if (ok && !done) seePath.hidden = false;
      });
    }

    // --- the one answer
    if (start) {
      const card = make('section', 'start-card');
      const label = make('h2', 'start-label', 'Start here');
      label.id = 'startHereLabel';
      card.setAttribute('aria-labelledby', label.id);
      const look = moduleLook(start);
      card.dataset.accent = look.accent;
      const tile = make('span', 'tile start-tile');
      tile.setAttribute('aria-hidden', 'true');
      tile.append(icon(look.icon, 30));
      const text = make('div', 'start-text');
      text.append(label, make('p', 'start-title', start.title), make('p', 'start-why', start.why));
      const top = make('div', 'start-top');
      top.append(tile, text);
      const go = button(`Start with ${start.title}`, { kind: 'accent', onClick: () => open(start), id: 'btnStartHere' });
      go.classList.add('btn-lg');
      go.append(uiIcon('arrow', 16));
      card.append(top, actionBar([go, ...(seePath ? [seePath] : [])]));
      nodes.push(card);
    } else {
      nodes.push(make('p', 'learn-lede', 'You can start with any area.'));
      if (seePath) nodes.push(actionBar([seePath]));
    }

    // --- the goal they gave (or the defaults), and a way back to change it
    const line = onGoal && goal ? goalLine(goal) : '';
    if (line) {
      const recap = make('p', 'goal-recap');
      const change = button('Change', { kind: 'quiet', onClick: () => goalQuestion(levels, mastery), id: 'btnChangeGoal' });
      change.setAttribute('aria-label', 'Change your goal');
      recap.append(make('span', 'goal-recap-text', line), change);
      nodes.push(recap);
    }

    // --- what they told us: one quiet line per area, a shape and words for the level (never colour alone)
    const told = make('section', 'told');
    const toldHead = make('h2', 'told-title', 'What you told us');
    toldHead.id = 'toldLabel';
    told.setAttribute('aria-labelledby', toldHead.id);
    const list = make('ul', 'told-list');
    // When everything is strong the card only suggests one: each area can then be opened from its own line.
    const pickable = start?.level === 'strong';
    for (const r of rows) {
      const li = make('li', 'told-row');
      li.dataset.area = r.area;
      li.dataset.level = r.level;
      const dot = make('span', 'told-dot');
      dot.dataset.level = r.level;
      dot.setAttribute('aria-hidden', 'true');
      let name;
      if (pickable) {
        name = button(r.title, { kind: 'quiet', onClick: () => open(r) });
        name.classList.add('told-open');
        name.setAttribute('aria-label', `Open ${r.title}`);
      } else {
        name = make('span', 'told-name', r.title);
      }
      li.append(dot, name, make('span', 'told-phrase', r.phrase));
      list.append(li);
    }
    told.append(toldHead, list);
    nodes.push(told);

    // --- one short explanation, and the way out
    nodes.push(
      make('p', 'learn-note muted small', 'We shorten lessons on what you already know and open them in full where it is new. You can still open or skip any lesson.'),
      make('p', 'learn-note muted small', 'You can retake this any time from the ? menu.'),
      actionBar([button('Browse all labs', { kind: 'quiet', onClick: () => leave(true), id: 'btnOnboardingDone2' })])
    );

    show(host, ...nodes);
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
