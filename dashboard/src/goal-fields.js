/**
 * The two questions that turn the platform quiz into a path: what the learner is aiming for, and how many hours
 * a week they can give it. The quiz asks them on two screens (onboarding.js) and "Change my goal" asks them
 * together on the path page (path-view.js), so the fields live here once.
 *
 * Both are always answerable: something is selected from the start (what was chosen last time, or "Explore"
 * and 4 hours), so a learner can press Next without having to decide. What they last said is kept in this
 * browser (localStorage 'opalixPathGoal') only to fill the fields in again; the path itself is built from what
 * was sent to the server.
 */

/** The three kinds of goal, as the service takes them. */
export const GOAL_KINDS = [
  { value: 'role-ready', label: 'Be ready for a role', hint: 'Work towards doing this job, with the labs that matter most for it.' },
  { value: 'specific-skill', label: 'Learn a specific skill', hint: 'Go deep on one thing you need to be able to do.' },
  { value: 'explore', label: 'Explore', hint: 'Look around the whole platform and see what interests you.' },
];

/** The hours a week that have a button; any whole number from 1 to 20 is allowed. */
export const HOUR_CHOICES = [2, 4, 6, 10];
export const MIN_HOURS = 1;
export const MAX_HOURS = 20;
/** The longest goal line the service takes. */
export const GOAL_TEXT_MAX = 200;
export const DEFAULT_GOAL = { goal_kind: 'explore', goal_text: '', hours_per_week: 4 };
export const GOAL_STORAGE = 'opalixPathGoal';

/** A whole number from 1 to 20 from what was typed, or null. */
export function parseHours(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n >= MIN_HOURS && n <= MAX_HOURS ? n : null;
}

/** Whatever was stored, as a goal that is valid: what does not fit falls back to the default. */
export function normalizeGoal(raw) {
  const out = { ...DEFAULT_GOAL };
  if (!raw || typeof raw !== 'object') return out;
  if (GOAL_KINDS.some((k) => k.value === raw.goal_kind)) out.goal_kind = raw.goal_kind;
  if (typeof raw.goal_text === 'string') out.goal_text = raw.goal_text.replace(/\s+/g, ' ').trim().slice(0, GOAL_TEXT_MAX);
  const hours = parseHours(raw.hours_per_week);
  if (hours !== null) out.hours_per_week = hours;
  return out;
}

export function loadGoal(storage) {
  try {
    return normalizeGoal(JSON.parse((storage ?? globalThis.localStorage)?.getItem(GOAL_STORAGE) ?? 'null'));
  } catch {
    return { ...DEFAULT_GOAL };
  }
}

export function saveGoal(goal, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(GOAL_STORAGE, JSON.stringify(normalizeGoal(goal)));
  } catch {
    /* private mode: the fields simply start from the defaults next time */
  }
}

/**
 * The quiz result as the service's `areas`: every area the quiz set a level for, with the console's own
 * `ok` as it is (the service takes it as "familiar").
 */
export function areasFromLevels(levels) {
  const out = {};
  if (!levels || typeof levels !== 'object') return out;
  for (const [area, level] of Object.entries(levels)) {
    if (/^[a-z]{2,24}$/.test(area) && ['new', 'ok', 'strong'].includes(level)) out[area] = level;
  }
  return out;
}

/** The body of PUT /api/path-inputs. A goal line left empty is left out. */
export function pathInputsBody({ levels, goal }) {
  const g = normalizeGoal(goal);
  const body = { areas: areasFromLevels(levels), goal_kind: g.goal_kind, hours_per_week: g.hours_per_week };
  if (g.goal_text) body.goal_text = g.goal_text;
  return body;
}

// ------------------------------------------------------------------ the fields

let uid = 0;

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * "What are you aiming for?": three choices (one is always picked) and an optional line about the goal.
 * `value()` is `{ goal_kind, goal_text }`. `legend` names the group; pass a different one when a screen's
 * own heading already asks the question.
 */
export function goalKindField({ initial = DEFAULT_GOAL, legend = 'What are you aiming for?', legendClass = 'ob-legend' } = {}) {
  const n = ++uid;
  const start = normalizeGoal(initial);
  const root = make('div', 'goal-field');

  const set = make('fieldset', 'ob-set goal-set');
  set.id = `goalKind${n}`;
  set.append(make('legend', legendClass, legend));
  const choices = make('div', 'ob-choices goal-choices');
  const radios = [];
  for (const kind of GOAL_KINDS) {
    const label = make('label', 'ob-choice');
    const input = make('input');
    input.type = 'radio';
    input.name = `goalKind${n}`;
    input.value = kind.value;
    input.checked = kind.value === start.goal_kind;
    radios.push(input);
    const text = make('span', 'ob-choice-text');
    text.append(make('span', 'ob-choice-title', kind.label), make('span', 'ob-choice-blurb', kind.hint));
    label.append(input, text);
    choices.append(label);
  }
  set.append(choices);

  const textLabel = make('label', 'goal-text-label', 'In a few words, what is it? (optional)');
  const text = make('input', 'goal-text');
  text.type = 'text';
  text.id = `goalText${n}`;
  text.maxLength = GOAL_TEXT_MAX;
  text.autocomplete = 'off';
  text.placeholder = "For example: run our company's AI gateway";
  text.value = start.goal_text;
  textLabel.htmlFor = text.id;
  const count = make('p', 'goal-text-count muted small');
  const showCount = () => {
    count.textContent = `${text.value.length} of ${GOAL_TEXT_MAX} characters`;
  };
  text.addEventListener('input', showCount);
  showCount();
  root.append(set, textLabel, text, count);

  return {
    root,
    value: () => ({
      goal_kind: radios.find((r) => r.checked)?.value ?? DEFAULT_GOAL.goal_kind,
      goal_text: text.value.replace(/\s+/g, ' ').trim().slice(0, GOAL_TEXT_MAX),
    }),
    focus: () => (radios.find((r) => r.checked) ?? radios[0]).focus(),
  };
}

/**
 * "How many hours a week can you give this?": chips for 2, 4, 6 and 10, and a box for any other whole number
 * from 1 to 20. `value()` is the hours, or null when what is typed is not one; `validate()` says why in a
 * polite live message and returns whether it is fine.
 */
export function hoursField({ initial = DEFAULT_GOAL, legend = 'How many hours a week can you give this?', legendClass = 'ob-legend' } = {}) {
  const n = ++uid;
  const start = normalizeGoal(initial).hours_per_week;
  const root = make('div', 'goal-field');
  const set = make('fieldset', 'ob-set goal-set');
  set.id = `goalHours${n}`;
  set.append(make('legend', legendClass, legend));

  const chips = make('div', 'chip-choices');
  const radios = [];
  for (const hours of HOUR_CHOICES) {
    const label = make('label', 'chip-choice');
    const input = make('input');
    input.type = 'radio';
    input.name = `goalHours${n}`;
    input.value = String(hours);
    input.checked = hours === start;
    radios.push(input);
    label.append(input, make('span', 'chip-choice-text', `${hours} hours`));
    chips.append(label);
  }
  const custom = make('label', 'chip-choice chip-choice-other');
  const customRadio = make('input');
  customRadio.type = 'radio';
  customRadio.name = `goalHours${n}`;
  customRadio.value = 'other';
  customRadio.setAttribute('aria-label', 'Other number of hours');
  const customBox = make('input', 'hours-input');
  customBox.type = 'number';
  customBox.min = String(MIN_HOURS);
  customBox.max = String(MAX_HOURS);
  customBox.step = '1';
  customBox.inputMode = 'numeric';
  customBox.id = `goalHoursOther${n}`;
  customBox.setAttribute('aria-label', `Another number of hours a week, from ${MIN_HOURS} to ${MAX_HOURS}`);
  customBox.placeholder = 'Other';
  if (!HOUR_CHOICES.includes(start)) {
    customRadio.checked = true;
    customBox.value = String(start);
  }
  custom.append(customRadio, customBox);
  chips.append(custom);
  radios.push(customRadio);
  set.append(chips);

  const message = make('p', 'goal-hours-message');
  message.id = `goalHoursMessage${n}`;
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  customBox.setAttribute('aria-describedby', message.id);
  root.append(set, message);

  // Typing in the box means "other"; picking a chip clears what was typed.
  customBox.addEventListener('input', () => {
    customRadio.checked = true;
    message.textContent = '';
  });
  set.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target !== customRadio && event.target.type === 'radio') {
      customBox.value = '';
      message.textContent = '';
    }
  });

  const value = () => {
    const picked = radios.find((r) => r.checked);
    if (!picked) return null;
    return picked === customRadio ? parseHours(customBox.value) : Number(picked.value);
  };
  return {
    root,
    value,
    validate() {
      const ok = value() !== null;
      message.textContent = ok ? '' : `Enter a whole number of hours from ${MIN_HOURS} to ${MAX_HOURS}.`;
      if (!ok) customBox.focus();
      return ok;
    },
    focus: () => (radios.find((r) => r.checked) ?? radios[0]).focus(),
  };
}
