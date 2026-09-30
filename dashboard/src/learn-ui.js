/**
 * The pieces the learning screens share: a question, a lesson card and the
 * small helpers around them. DOM only (no markup strings: every string goes in as
 * text), no knowledge of the API or of storage; the screens in onboarding.js,
 * before-you-begin.js and learn-tab.js put them together.
 *
 * Accessibility notes that apply to all of it:
 *   - a screen's heading takes focus when the screen changes (focusHeading)
 *   - the answer feedback is a live region that also takes focus, so a screen
 *     reader hears it and the Next button is the next tab stop
 *   - colour never carries the result alone: every option says "Correct
 *     answer" or "Not this one" in words
 */

import { gradeQuestion, readingTime } from './learn-model.js';
import { mountMarkdown } from './markdown.js';

/** Element with a class and optional text. */
export function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A button. `kind` is one of the console's: 'primary', 'ghost', or nothing. */
export function button(label, { kind = '', onClick, type = 'button', id } = {}) {
  const b = make('button', `btn${kind ? ` btn-${kind}` : ''}`, label);
  b.type = type;
  if (id) b.id = id;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Moves focus to a screen's heading (it has tabindex -1) so the change is announced. */
export function focusHeading(root) {
  const h = root.querySelector('[data-learn-heading]');
  if (h) h.focus({ preventScroll: false });
}

/** A screen's head: an eyebrow line, the h1 that takes focus, and an optional meta line. */
export function screenHead({ eyebrow, title, meta, id }) {
  const head = make('header', 'learn-head');
  if (eyebrow) head.append(make('p', 'learn-eyebrow', eyebrow));
  const h1 = make('h1', 'learn-title', title);
  h1.tabIndex = -1;
  h1.setAttribute('data-learn-heading', '');
  if (id) h1.id = id;
  head.append(h1);
  if (meta) head.append(make('p', 'learn-meta', meta));
  return head;
}

/** A row of actions; `sticky` keeps it at the foot of the scrolling screen. */
export function actionBar(children, { sticky = false, label } = {}) {
  const bar = make('div', `learn-actions${sticky ? ' learn-actions-sticky' : ''}`);
  if (label) bar.setAttribute('aria-label', label);
  bar.append(...children);
  return bar;
}

/** A thin progress bar; decorative, the text beside it says the same. */
function progressBar(done, total) {
  const bar = make('div', 'quiz-bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = make('span');
  fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  bar.append(fill);
  return bar;
}

let uid = 0;

/**
 * One question on its own screen.
 *
 *   question   { id, concept, type: 'single' | 'multi', prompt, options, answer, explanation }
 *   index      0-based position; total the number of questions
 *   onNext     called with { question_id, concept, correct, selected } when the
 *              learner presses Next (or Finish) after checking
 *   lastLabel  what Next says on the last question (default "Finish")
 *
 * Single choice is radios, multiple is checkboxes. "Check" reveals whether the
 * answer was right with the explanation, in a live region; nothing is
 * revealed before. Returns { root } (the heading inside it takes focus).
 */
export function questionScreen({ question, index, total, onNext, lastLabel = 'Finish' }) {
  const id = `q${++uid}`;
  const multi = question.type === 'multi';
  const root = make('div', 'quiz');

  const head = screenHead({ title: `Question ${index + 1} of ${total}` });
  head.classList.add('quiz-head');
  head.append(progressBar(index, total));
  root.append(head);

  const form = make('form', 'quiz-form');
  form.noValidate = true;
  const set = make('fieldset', 'quiz-set');
  const legend = make('legend', 'quiz-prompt', question.prompt);
  legend.id = `${id}-prompt`;
  set.append(legend, make('p', 'quiz-hint', multi ? 'Choose all that apply.' : 'Choose one answer.'));

  const options = make('div', 'quiz-options');
  const inputs = [];
  for (const opt of question.options) {
    const label = make('label', 'quiz-option');
    label.dataset.option = opt.id;
    const input = make('input');
    input.type = multi ? 'checkbox' : 'radio';
    input.name = id;
    input.value = opt.id;
    inputs.push(input);
    const text = make('span', 'quiz-option-text', opt.text);
    const flag = make('span', 'quiz-option-flag');
    label.append(input, text, flag);
    options.append(label);
  }
  set.append(options);
  form.append(set);

  const feedback = make('div', 'quiz-feedback');
  feedback.tabIndex = -1;
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  const check = button('Check', { kind: 'primary', type: 'submit' });
  const next = button(index + 1 >= total ? lastLabel : 'Next', { kind: 'primary', type: 'button' });
  next.hidden = true;
  const actions = actionBar([check, next]);
  form.append(feedback, actions);
  root.append(form);

  let result = null;
  const selected = () => inputs.filter((i) => i.checked).map((i) => i.value);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (result) return;
    const chosen = selected();
    if (chosen.length === 0) {
      feedback.dataset.result = 'none';
      feedback.textContent = multi ? 'Choose at least one answer, then check.' : 'Choose an answer, then check.';
      feedback.focus();
      return;
    }
    const correct = gradeQuestion(question, chosen);
    result = { question_id: question.id, concept: question.concept, correct, selected: chosen };
    for (const label of options.children) {
      const optId = label.dataset.option;
      const right = question.answer.includes(optId);
      const picked = chosen.includes(optId);
      const flag = label.querySelector('.quiz-option-flag');
      if (right) {
        label.dataset.state = 'correct';
        flag.textContent = picked ? 'Correct answer, your choice' : 'Correct answer';
      } else if (picked) {
        label.dataset.state = 'incorrect';
        flag.textContent = 'Not this one';
      }
      label.querySelector('input').disabled = true;
    }
    feedback.dataset.result = correct ? 'correct' : 'incorrect';
    feedback.textContent = '';
    feedback.append(make('strong', 'quiz-verdict', correct ? 'Correct.' : 'Not quite.'), document.createTextNode(` ${question.explanation}`));
    check.hidden = true;
    next.hidden = false;
    feedback.focus();
  });

  next.addEventListener('click', () => {
    if (result) onNext(result);
  });

  return { root };
}

/**
 * One lesson, folded to its recap or open in full.
 *
 *   concept    { id, title, minutes, recap, body }
 *   state      'expanded' | 'collapsed'
 *   mode       'plan' (Before you begin) or 'tab' (the session's Learn tab)
 *   chip       optional short text about why it starts this way ("You know this")
 *   onAction   plan mode: called with 'forced' (Show me the lesson anyway) or
 *              'skipped' (I know this, skip); the caller records it and calls update()
 *   headingTag the tag of the lesson title (default h2)
 *
 * Tab mode has one toggle (aria-expanded) that only changes what is showing.
 * The body, with its diagrams, is built the first time the lesson opens and
 * its players are stopped by destroy(). Returns { root, update, destroy }.
 */
export function lessonCard({ concept, state, mode, chip, onAction, headingTag = 'h2' }) {
  const root = make('article', 'lesson');
  root.dataset.concept = concept.id;
  const bodyId = `lesson-${++uid}`;
  let current = state;
  let chipText = chip;
  let body = null;
  let markdown = null;

  const build = (focusAfter) => {
    root.dataset.state = current;
    root.replaceChildren();
    const head = make('div', 'lesson-head');
    const title = make(headingTag, 'lesson-title', concept.title);
    head.append(title);
    const meta = make('span', 'lesson-meta', `${concept.minutes} min`);
    head.append(meta);
    if (chipText) head.append(make('span', 'chip lesson-chip', chipText));
    root.append(head);

    let focusTarget = null;
    if (current === 'collapsed') {
      root.append(make('p', 'lesson-recap', concept.recap));
    } else {
      if (!body) {
        body = make('div', 'lesson-body');
        body.id = bodyId;
        markdown = mountMarkdown(body, concept.body, { headingLevel: Number(headingTag.slice(1)) + 1 });
      }
      root.append(body);
    }

    if (mode === 'plan') {
      const b =
        current === 'collapsed'
          ? button('Show me the lesson anyway', { onClick: () => onAction?.('forced') })
          : button('I know this, skip', { kind: 'ghost', onClick: () => onAction?.('skipped') });
      b.classList.add('lesson-toggle');
      root.append(b);
      focusTarget = b;
    } else {
      const open = current === 'expanded';
      const b = button(open ? 'Hide lesson' : 'Show lesson', {
        kind: 'ghost',
        onClick: () => {
          current = current === 'expanded' ? 'collapsed' : 'expanded';
          build(true);
        },
      });
      b.classList.add('lesson-toggle');
      b.setAttribute('aria-expanded', String(open));
      b.setAttribute('aria-controls', bodyId);
      if (!open) b.removeAttribute('aria-controls');
      head.append(b);
      focusTarget = b;
    }
    if (focusAfter && focusTarget) focusTarget.focus();
  };
  build(false);

  return {
    root,
    update({ state: next, chip: nextChip }, { focus = true } = {}) {
      current = next;
      chipText = nextChip;
      build(focus);
    },
    destroy() {
      markdown?.destroy();
      markdown = null;
    },
  };
}

/** "3 min read"-style line for a story. */
export const storyMeta = (story) => readingTime(story?.minutes);

/** Rebuilds `host` from nodes; the old children go first. */
export function show(host, ...nodes) {
  host.replaceChildren(...nodes);
}
