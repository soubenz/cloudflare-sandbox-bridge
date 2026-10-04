/**
 * The pieces the learning screens share: a question, a lesson card and the
 * small helpers around them. DOM only (no markup strings: every string goes in as
 * text), no knowledge of the API or of storage; the screens in onboarding.js,
 * before-you-begin.js and learn-lessons.js put them together.
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
import { mountComic } from './comic.js';
import { uiIcon } from './icons.js';

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

/**
 * The story of a learn bundle: the motion comic when the bundle has one, with
 * the text story folded under it ("Read the story as text"), else the text
 * story alone. The text story is also the complete fallback when the comic
 * cannot be drawn (a malformed bundle, a browser without what it needs): a
 * mount that throws leaves nothing behind and the text shows as if there were
 * no comic.
 *
 *   learn          the bundle ({ story, comic? })
 *   headingLevel   the level the story's own headings start at
 *   onDone         called when the comic has played to its end (or was skipped)
 *
 * Returns { node, hasComic, destroy }; `destroy` stops the comic's clock and the markdown's diagrams.
 */
export function storyContent(learn, { headingLevel = 2, onDone } = {}) {
  const prose = make('div', 'learn-prose story-quote');
  const markdown = learn.story ? mountMarkdown(prose, learn.story.body, { headingLevel }) : null;
  let comic = null;
  const holder = make('div', 'cm-holder');
  if (learn.comic) {
    try {
      comic = mountComic(holder, learn.comic, { onDone, audio: learn.audio });
    } catch {
      comic = null;
    }
  }
  if (!comic) {
    return { node: prose, hasComic: false, destroy: () => markdown?.destroy() };
  }
  const nodes = [holder];
  if (markdown) {
    const fold = make('details', 'cm-story-text');
    fold.append(make('summary', '', 'Read the story as text'), prose);
    nodes.push(fold);
  }
  const node = make('div', 'cm-story');
  node.append(...nodes);
  return {
    node,
    hasComic: true,
    destroy() {
      comic.destroy();
      markdown?.destroy();
    },
  };
}

/** Moves focus to a screen's heading (it has tabindex -1) so the change is announced. */
export function focusHeading(root) {
  const h = root.querySelector('[data-learn-heading]');
  if (h) h.focus({ preventScroll: false });
}

/**
 * The progress-steps bar at the top of a learning screen: `total` segments, the
 * first `current` of them filled. Decoration only (the heading and the eyebrow say
 * where the learner is), so it is hidden from assistive technology.
 */
export function stepBar(current, total, done = false) {
  const bar = make('div', done ? 'steps steps-done' : 'steps');
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 1; i <= total; i++) bar.append(make('i', i <= current ? 'on' : ''));
  // The last screen: every segment is filled, and a check with "Done" says why.
  if (done) {
    const mark = make('span', 'steps-done-label');
    mark.append(uiIcon('check', 14), document.createTextNode('Done'));
    bar.append(mark);
  }
  return bar;
}

/**
 * The quiet progress dots of the pre-lab flow: one small dot per step (the story a page, a round
 * of questions a dot, a chunk of lessons a rounded square) and a flag at the end for Start the lab.
 * The ones before `current` (1-based) are filled, `current` has a ring. Decoration only: the
 * heading, the eyebrow and the live region say where the learner is.
 */
export function stepDots(kinds, current) {
  const bar = make('div', 'steps steps-dots');
  bar.setAttribute('aria-hidden', 'true');
  kinds.forEach((kind, i) => {
    const dot = make('i', i + 1 < current ? 'done' : i + 1 === current ? 'now' : '');
    dot.dataset.kind = kind;
    bar.append(dot);
  });
  const end = make('i', 'end');
  end.dataset.kind = 'start';
  bar.append(end);
  return bar;
}

/**
 * A screen's head: the steps bar, an eyebrow line, the h1 that takes focus and an
 * optional meta line.
 *
 *   steps   { current, total, done? } for the bar (`done`: the last screen, drawn as finished), or { current, kinds } for the pre-lab flow's dots (see stepDots)
 *   mark    the end of `title` to set on the accent highlighter, as the landing page does
 *   badge   a small navy badge beside the meta line ("Case file")
 */
export function screenHead({ eyebrow, title, meta, id, steps, mark, badge }) {
  const head = make('header', 'learn-head');
  if (steps) head.append(steps.kinds ? stepDots(steps.kinds, steps.current) : stepBar(steps.current, steps.total, steps.done === true));
  if (eyebrow) head.append(make('p', 'learn-eyebrow', eyebrow));
  const h1 = make('h1', 'learn-title');
  if (mark && title.endsWith(mark)) h1.append(document.createTextNode(title.slice(0, -mark.length)), make('span', 'mark', mark));
  else h1.textContent = title;
  h1.tabIndex = -1;
  h1.setAttribute('data-learn-heading', '');
  if (id) h1.id = id;
  head.append(h1);
  if (meta || badge) {
    const row = make('div', 'learn-metarow');
    if (badge) row.append(make('span', 'badge badge-case', badge));
    if (meta) row.append(make('p', 'learn-meta', meta));
    head.append(row);
  }
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
 *   title      the heading, instead of "Question N of M" (an adaptive quiz does not
 *              know M); eyebrow is an optional line above it
 *   allowUnsure  adds a "Not sure" button beside Check: it reveals the answer and
 *              the explanation without a verdict and reports { correct: false,
 *              unsure: true }; nothing about it says the learner failed
 *   nextLabelFor  (result) => what Next says once this one is answered
 *   steps      { current, total } for the screen's progress-steps bar
 *   onAnswer   called once with the result the moment the answer is revealed (not when it is restored)
 *   answered   a result given before ({ selected, correct, unsure? }): the question then shows
 *              as answered, with its feedback and Next, and nothing is reported again
 *
 * Single choice is radios, multiple is checkboxes. "Check" reveals whether the
 * answer was right with the explanation, in a live region; nothing is
 * revealed before. Returns { root, next } (the heading inside it takes focus; `next` is the button
 * that moves on, for a screen that has to name it).
 */
export function questionScreen({ question, index, total, onNext, lastLabel = 'Finish', title, eyebrow, allowUnsure = false, nextLabelFor, steps, onAnswer, answered }) {
  const id = `q${++uid}`;
  const multi = question.type === 'multi';
  const root = make('div', 'quiz');

  const head = screenHead({ eyebrow, title: title ?? `Question ${index + 1} of ${total}`, steps });
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
  const unsure = allowUnsure ? button('Not sure', { kind: 'ghost', type: 'button', id: 'btnNotSure' }) : null;
  const actions = actionBar([check, ...(unsure ? [unsure] : []), next]);
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
    reveal(chosen, gradeQuestion(question, chosen), false);
  });

  unsure?.addEventListener('click', () => {
    if (!result) reveal([], false, true);
  });

  /** Marks the right options, explains, and swaps Check for Next. `restored` is a result shown again, not a new answer. */
  function reveal(chosen, correct, notSure, restored = false) {
    result = { question_id: question.id, concept: question.concept, correct, selected: chosen, ...(notSure ? { unsure: true } : {}) };
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
    feedback.dataset.result = notSure ? 'unsure' : correct ? 'correct' : 'incorrect';
    feedback.textContent = '';
    const verdict = notSure ? 'No problem.' : correct ? 'Correct.' : 'Not quite.';
    feedback.append(make('strong', 'quiz-verdict', verdict), document.createTextNode(` ${question.explanation}`));
    check.hidden = true;
    if (unsure) unsure.hidden = true;
    if (nextLabelFor) next.textContent = nextLabelFor(result);
    next.hidden = false;
    feedback.focus();
    if (!restored) onAnswer?.(result);
  }

  next.addEventListener('click', () => {
    if (result) onNext(result);
  });

  if (answered && Array.isArray(answered.selected)) {
    for (const input of inputs) input.checked = answered.selected.includes(input.value);
    reveal(answered.selected, answered.correct === true, answered.unsure === true, true);
  }

  return { root, next };
}

/**
 * One lesson, folded to its recap or open in full.
 *
 *   concept    { id, title, minutes, recap, body }
 *   state      'expanded' | 'collapsed'
 *   chip       optional short text about why it starts this way ("You know this")
 *   onAction   called with 'forced' (Show me the lesson anyway) or 'skipped'
 *              (I know this, skip); the caller records it and calls update()
 *   headingTag the tag of the lesson title (default h2)
 *
 * The body, with its diagrams, is built the first time the lesson opens and
 * its players are stopped by destroy(). Returns { root, update, destroy }.
 */
export function lessonCard({ concept, state, chip, onAction, headingTag = 'h2' }) {
  const root = make('article', 'lesson');
  root.dataset.concept = concept.id;
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

    if (current === 'collapsed') {
      root.append(make('p', 'lesson-recap', concept.recap));
    } else {
      if (!body) {
        body = make('div', 'lesson-body');
        markdown = mountMarkdown(body, concept.body, { headingLevel: Number(headingTag.slice(1)) + 1 });
      }
      root.append(body);
    }

    const toggle =
      current === 'collapsed'
        ? button('Show me the lesson anyway', { kind: 'quiet', onClick: () => onAction?.('forced') })
        : button('I know this, skip', { kind: 'ghost', onClick: () => onAction?.('skipped') });
    toggle.classList.add('lesson-toggle');
    head.append(toggle);
    if (focusAfter) toggle.focus();
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
