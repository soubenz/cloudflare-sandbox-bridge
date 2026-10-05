/**
 * The learner's own path: the "Your path" band on Home and the page at /paths/mine.
 *
 * The labs, their order and the reason for each (`why`) are the service's (GET /api/path). This file lays them out,
 * says what state each step is in (in words: Done, Next up, Coming up, Locked), and asks the same two questions
 * the quiz ends with when the learner wants to change their goal. A learner-written goal goes in through
 * textContent, like everything else from outside this file.
 */
import { icon, svgIcon } from './icons.js';
import { minutesLabel } from './launcher-model.js';
import { skillById, skillLook } from './skills.js';
import { GOAL_KINDS, goalKindField, hoursField, loadGoal } from './goal-fields.js';
import { adminOpenStep } from './admin-mode.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const STATUSES = ['done', 'next', 'upcoming', 'locked'];

/** What a step's state is called, always in words (the dot beside it is only a picture). */
export const STATUS_WORDS = { done: 'Done', next: 'Next up', upcoming: 'Coming up', locked: 'Locked' };
/** Why a step cannot be started, in plain words. */
export const LOCK_REASON = 'Part of the paid plan';
/** The service's stock line for a plan lock; an older response without `lock` is read as a plan lock only when `why` is this. */
export const STOCK_PLAN_WHY = 'Included with the Pro plan.';
const LOCKS = ['plan', 'prerequisite'];

/**
 * Why a locked step is locked: the service's `lock`, or for a response from before it existed, 'plan' when the
 * reason is the stock plan line and null (unknown: no Unlock button) for any other text.
 */
function lockKind(s) {
  if (LOCKS.includes(s.lock)) return s.lock;
  return s.why === STOCK_PLAN_WHY ? 'plan' : null;
}

/** The path as the page may rely on it: every step has a slug, a title, a status and a why line. */
export function normalizePath(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .filter((s) => s && typeof s === 'object' && typeof s.slug === 'string' && SLUG.test(s.slug) && STATUSES.includes(s.status))
    .map((s) => ({
      slug: s.slug,
      title: typeof s.title === 'string' && s.title ? s.title : s.slug,
      area: typeof s.area === 'string' ? s.area : null,
      why: typeof s.why === 'string' ? s.why : '',
      minutes: Number.isFinite(Number(s.estimated_minutes)) ? Number(s.estimated_minutes) : 0,
      status: s.status,
      lock: s.status === 'locked' ? lockKind(s) : null,
    }));
  const total = Number(raw.total_minutes);
  const weeks = Number(raw.weeks_estimate);
  return {
    steps,
    totalMinutes: Number.isFinite(total) ? total : 0,
    weeks: Number.isFinite(weeks) ? weeks : 0,
    goal: raw.goal && typeof raw.goal === 'object' ? { text: typeof raw.goal.text === 'string' ? raw.goal.text : '', kind: typeof raw.goal.kind === 'string' ? raw.goal.kind : 'explore' } : { text: '', kind: 'explore' },
  };
}

/** The step to do next, or null when nothing is left. */
export const nextStep = (path) => path.steps.find((s) => s.status === 'next') ?? null;

/** The steps that follow the next one, as the mini timeline shows them (up to `count`). */
export const comingUp = (path, count = 3) => path.steps.filter((s) => s.status === 'upcoming').slice(0, count);

/** "3 h 20 min to go · about 2 weeks", or that nothing is left. */
export function totalsLine(path) {
  if (path.totalMinutes <= 0) return 'Nothing left to do on this path.';
  const weeks = path.weeks > 0 ? ` · about ${path.weeks} ${path.weeks === 1 ? 'week' : 'weeks'}` : '';
  return `${minutesLabel(path.totalMinutes)} to go${weeks}`;
}

export const goalKindLabel = (kind) => GOAL_KINDS.find((k) => k.value === kind)?.label ?? 'Explore';

/** The chip for a step's skill: its title, in the skill's colour. */
function areaChip(area) {
  if (!area) return null;
  const skill = skillById(area);
  const chip = el('span', 'chip chip-area', skill?.title ?? area);
  chip.dataset.accent = skillLook(area).accent;
  return chip;
}

const startLabel = (deps, slug) => (deps.isRunning?.(slug) ? 'Resume' : 'Start');

/** A Start or Resume button for a known lab; null for one the catalogue does not list. */
function startButton(step, deps, row, kind = 'btn-strong') {
  if (!deps.labKnown?.(step.slug)) return null;
  const button = el('button', `btn ${deps.isRunning?.(step.slug) ? 'btn-accent' : kind} lab-start`, startLabel(deps, step.slug));
  button.type = 'button';
  button.dataset.slug = step.slug;
  button.addEventListener('click', () => deps.onStart?.(step.slug, row));
  return button;
}

const labHref = (slug) => `/labs/${encodeURIComponent(slug)}`;

// ------------------------------------------------------------------ Home: "Your path"

/**
 * The band at the top of Home: the next lab as a big card with the reason for it, the three steps after it as a
 * small timeline, how long is left, and a link to the whole path.
 */
export function pathBand(rawPath, deps = {}) {
  const path = normalizePath(rawPath);
  if (!path || !path.steps.length) return null;
  const band = el('section', 'path-band');
  band.id = 'homePath';
  band.setAttribute('aria-labelledby', 'homePathHeading');
  const head = el('div', 'band-head');
  const heading = el('h2', 'band-title', 'Your path');
  heading.id = 'homePathHeading';
  const link = el('a', 'btn btn-ghost band-link', 'See the whole path');
  link.href = '/paths/mine';
  head.append(heading, link);
  band.append(head);
  if (path.goal.text) band.append(el('p', 'path-goal', `Your goal: ${path.goal.text}`));

  const body = el('div', 'path-band-body');
  const next = nextStep(path);
  if (next) {
    const card = el('article', 'next-card');
    card.dataset.slug = next.slug;
    card.setAttribute('aria-labelledby', 'nextLabTitle');
    const accent = next.area ? skillLook(next.area).accent : 'blue';
    card.dataset.accent = accent;
    card.append(el('p', 'next-eyebrow', 'Next lab'));
    const title = el('h3', 'next-title');
    title.id = 'nextLabTitle';
    const titleLink = el('a', '', next.title);
    titleLink.href = labHref(next.slug);
    title.append(titleLink);
    card.append(title);
    if (next.why) card.append(el('p', 'next-why', next.why));
    const meta = el('div', 'next-meta');
    const chip = areaChip(next.area);
    if (chip) meta.append(chip);
    if (next.minutes > 0) meta.append(el('span', 'chip', minutesLabel(next.minutes)));
    card.append(meta);
    const start = startButton(next, deps, card);
    if (start) {
      start.classList.add('btn-lg');
      card.append(start);
    }
    body.append(card);
  } else {
    const done = el('div', 'next-card next-card-done');
    done.append(el('p', 'next-eyebrow', 'All done'), el('p', 'next-why', 'You have finished every lab on your path. Open the whole path to look back, or change your goal to get a new one.'));
    body.append(done);
  }

  const side = el('div', 'mini-path');
  const upcoming = comingUp(path);
  if (upcoming.length) {
    const sub = el('h3', 'band-sub', 'Coming up');
    sub.id = 'miniPathHeading';
    const steps = el('ol', 'mini-steps');
    steps.setAttribute('aria-labelledby', 'miniPathHeading');
    for (const step of upcoming) {
      const li = el('li', 'mini-step');
      li.dataset.slug = step.slug;
      li.append(el('span', 'mini-dot'));
      const text = el('span', 'mini-step-text');
      const a = el('a', 'mini-step-title', step.title);
      a.href = labHref(step.slug);
      text.append(a);
      if (step.minutes > 0) text.append(el('span', 'mini-step-time', minutesLabel(step.minutes)));
      li.append(text);
      steps.append(li);
    }
    side.append(sub, steps);
  }
  side.append(el('p', 'path-totals', totalsLine(path)));
  body.append(side);
  band.append(body);
  return band;
}

/** Home's invitation for a learner who took the quiz before paths existed: one line and a way in. */
export function pathInvite() {
  const band = el('section', 'path-band path-invite');
  band.id = 'homePath';
  band.setAttribute('aria-labelledby', 'homePathHeading');
  const head = el('div', 'band-head');
  const heading = el('h2', 'band-title', 'Your path');
  heading.id = 'homePathHeading';
  const link = el('a', 'btn btn-strong band-link', 'Make my path');
  link.href = '/paths/mine';
  head.append(heading, link);
  band.append(head, el('p', 'band-empty', 'Tell us what you are aiming for and we will line up the labs for you.'));
  return band;
}

// ------------------------------------------------------------------ the page

const CHECK = '<path d="M3.5 8.5l3 3 6-7"/>';

/** The line under a locked step: the paid-plan wording for a plan lock, otherwise the service's own sentence. */
const lockReason = (step) => (step.lock === 'plan' ? LOCK_REASON : step.why || LOCK_REASON);

function stepRow(step, index, deps) {
  const li = el('li', 'path-step');
  li.dataset.status = step.status;
  li.dataset.slug = step.slug;
  const titleId = `pathStep-${step.slug.replace(/[^a-z0-9_-]/gi, '-')}`;
  li.setAttribute('aria-labelledby', titleId);

  const num = el('span', 'step-num');
  num.setAttribute('aria-hidden', 'true');
  if (step.status === 'done') num.append(svgIcon(CHECK, 14, 16, 2));
  else if (step.status === 'locked') num.append(icon('lock', 14));
  else num.textContent = String(index);

  const main = el('div', 'step-main');
  const top = el('div', 'step-top');
  top.append(el('span', 'step-status', STATUS_WORDS[step.status]));
  const chip = areaChip(step.area);
  if (chip) top.append(chip);
  if (step.minutes > 0) top.append(el('span', 'chip', minutesLabel(step.minutes)));
  const title = el('h3', 'step-title');
  title.id = titleId;
  const link = el('a', '', step.title);
  link.href = labHref(step.slug);
  title.append(link);
  main.append(top, title);
  if (step.status !== 'locked' && step.why) main.append(el('p', 'step-why', step.why));

  const act = el('div', 'step-act');
  if (step.status === 'locked') {
    // A plan lock names the paid plan and offers the way to it; a lock behind another lab says which lab.
    const reason = el('p', 'step-lock', lockReason(step));
    reason.id = `${titleId}-lock`;
    const plans = step.lock === 'plan' ? deps.plansHref?.() : null;
    if (plans) {
      const unlock = el('a', 'btn btn-accent unlock-link', 'Unlock');
      unlock.href = plans;
      unlock.setAttribute('aria-label', `Unlock ${step.title} with a plan`);
      unlock.setAttribute('aria-describedby', reason.id);
      act.append(unlock, reason);
    } else {
      const locked = el('button', 'btn btn-ghost lab-start', 'Locked');
      locked.type = 'button';
      locked.setAttribute('aria-disabled', 'true');
      locked.setAttribute('aria-describedby', reason.id);
      act.append(locked, reason);
    }
  } else if (step.status === 'done') {
    const again = startButton(step, deps, li, 'btn-ghost');
    if (again) {
      again.textContent = deps.isRunning?.(step.slug) ? 'Resume' : 'Open again';
      act.append(again);
    }
  } else {
    const start = startButton(step, deps, li, step.status === 'next' ? 'btn-strong' : 'btn-ghost');
    if (start) act.append(start);
  }
  li.append(num, main, act);
  adminOpenStep(li, step, deps); // the owner's developer view only: a no-op for a learner
  return li;
}

/**
 * The goal form: the quiz's two questions together, filled in with what the learner said last time.
 *   onSave({ goal_kind, goal_text, hours_per_week })  -> a promise; a rejection is shown, in `errorText(err)`'s words
 *   onCancel()     closes it (absent when it is the whole page's job, as before a first path)
 */
export function goalForm({ onSave, onCancel, errorText = () => 'Please try again.', saveLabel = 'Save and update my path' }) {
  const initial = loadGoal();
  const form = el('form', 'goal-form');
  form.id = 'goalForm';
  form.noValidate = true;
  form.setAttribute('aria-labelledby', 'goalFormHeading');
  const heading = el('h2', 'goal-form-title', 'Your goal');
  heading.id = 'goalFormHeading';
  const kind = goalKindField({ initial, legend: 'What are you aiming for?', legendClass: 'goal-legend' });
  const hours = hoursField({ initial, legend: 'How many hours a week can you give this?', legendClass: 'goal-legend' });
  const error = el('p', 'notice notice-bad small goal-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const save = el('button', 'btn btn-strong', saveLabel);
  save.type = 'submit';
  const actions = el('div', 'goal-actions');
  actions.append(save);
  if (onCancel) {
    const cancel = el('button', 'btn btn-quiet', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', onCancel);
    actions.append(cancel);
  }
  form.append(heading, kind.root, hours.root, error, actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!hours.validate()) return;
    error.hidden = true;
    save.setAttribute('aria-busy', 'true');
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving…';
    try {
      await onSave({ ...kind.value(), hours_per_week: hours.value() });
    } catch (err) {
      error.textContent = `Could not save your goal. ${errorText(err)}`;
      error.hidden = false;
    } finally {
      save.removeAttribute('aria-busy');
      save.disabled = false;
      save.textContent = label;
    }
  });
  return { form, focus: () => kind.focus() };
}

/**
 * The page at /paths/mine, drawn from the store's state.
 *   state            { status, data, error }
 *   deps             { isRunning, labKnown, onStart, recompute, saveGoal, errorText, retry, say, formOpen, setFormOpen, plansHref }
 * `plansHref()` is the address of the plans page; a plan-locked step links to it with an Unlock button (none: no button).
 * `say(text)` writes to the page's polite live region (which outlives a redraw, so it is announced).
 * `formOpen()` / `setFormOpen(open)` are the page's own memory of whether the goal form is open, so a redraw
 * (a refresh that came back) does not close it under someone who is typing in it.
 */
export function myPathPage({ state, deps }) {
  const root = el('div', 'mypath-body');
  const path = normalizePath(state.data);
  const noInputs = !path && state.status === 'error' && state.error?.status === 404;

  if (!path && state.status === 'error' && !noInputs) {
    const note = el('div', 'notice notice-bad');
    note.setAttribute('role', 'alert');
    note.append(el('p', 'profile-error', `Could not load your path. ${deps.errorText?.(state.error) ?? ''}`.trim()));
    const again = el('button', 'btn', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => deps.retry?.());
    note.append(again);
    root.append(note);
    return root;
  }

  if (!path && !noInputs) {
    root.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 3; i++) {
      const bone = el('div', 'profile-skeleton');
      bone.setAttribute('aria-hidden', 'true');
      root.append(bone);
    }
    root.append(el('p', 'sr-only', 'Loading your path…'));
    return root;
  }

  if (noInputs) {
    root.append(el('p', 'mypath-lede', 'A path is a list of labs picked for you, in the order that suits you. Answer two questions and yours appears here and on the home page.'));
    const { form } = goalForm({ onSave: (goal) => deps.saveGoal(goal), errorText: deps.errorText, saveLabel: 'Make my path' });
    root.append(form);
    return root;
  }

  // The summary row: the goal, the time left, and the two things a learner can do about the path.
  const summary = el('section', 'mypath-summary');
  summary.setAttribute('aria-label', 'About your path');
  const facts = el('div', 'mypath-facts');
  const goal = el('p', 'mypath-goal');
  goal.append(el('span', 'mypath-goal-kind', goalKindLabel(path.goal.kind)));
  if (path.goal.text) goal.append(document.createTextNode(': '), el('span', 'mypath-goal-text', path.goal.text));
  facts.append(goal, el('p', 'mypath-totals', totalsLine(path)));
  const actions = el('div', 'mypath-actions');
  const recompute = el('button', 'btn', 'Recompute');
  recompute.type = 'button';
  recompute.id = 'btnRecompute';
  const change = el('button', 'btn btn-ghost', 'Change my goal');
  change.type = 'button';
  change.id = 'btnChangeGoal';
  change.setAttribute('aria-controls', 'goalForm');
  change.setAttribute('aria-expanded', String(Boolean(deps.formOpen?.())));
  actions.append(recompute, change);
  summary.append(facts, actions);
  root.append(summary);

  const holder = el('div', 'goal-holder');
  const openForm = (focus = true) => {
    holder.replaceChildren();
    const { form, focus: focusFirst } = goalForm({
      onSave: (goalInput) => deps.saveGoal(goalInput),
      onCancel: () => closeForm(true),
      errorText: deps.errorText,
    });
    holder.append(form);
    holder.hidden = false;
    change.setAttribute('aria-expanded', 'true');
    deps.setFormOpen?.(true);
    if (focus) focusFirst();
  };
  const closeForm = (focus) => {
    holder.replaceChildren();
    holder.hidden = true;
    change.setAttribute('aria-expanded', 'false');
    deps.setFormOpen?.(false);
    if (focus) change.focus();
  };
  holder.hidden = true;
  root.append(holder);
  if (deps.formOpen?.()) openForm(false);
  change.addEventListener('click', () => (holder.hidden ? openForm() : closeForm(false)));

  recompute.addEventListener('click', async () => {
    if (recompute.getAttribute('aria-busy') === 'true') return;
    recompute.setAttribute('aria-busy', 'true');
    recompute.disabled = true;
    deps.say?.('Working out your path again…');
    try {
      await deps.recompute();
      deps.say?.('Your path is up to date.');
    } catch (err) {
      deps.say?.(`Could not update your path. ${deps.errorText?.(err) ?? ''}`.trim());
    } finally {
      recompute.removeAttribute('aria-busy');
      recompute.disabled = false;
    }
  });

  const steps = el('section', 'mypath-steps');
  steps.setAttribute('aria-labelledby', 'mypathStepsHeading');
  const stepsHeading = el('h2', 'profile-section-title', 'Your steps');
  stepsHeading.id = 'mypathStepsHeading';
  steps.append(stepsHeading);
  if (path.steps.length) {
    const ol = el('ol', 'path-steps');
    path.steps.forEach((step, i) => ol.append(stepRow(step, i + 1, deps)));
    steps.append(ol);
  } else {
    steps.append(el('p', 'band-empty', 'No labs are lined up yet.'));
  }
  root.append(steps);
  return root;
}
