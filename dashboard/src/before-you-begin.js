/**
 * "Before you begin": the screen between pressing Start on a lab that has
 * learning content and the session booting.
 *
 *   story  ->  diagnostic questions (only for concepts not already known)
 *          ->  the plan: each lesson open in full or folded to its recap
 *
 * The check decides, the learner overrides: the questions only set the
 * default. A folded lesson has "Show me the lesson anyway", an open one "I
 * know this, skip", and both are remembered. The session starts only when
 * "Start the lab" is pressed (a container costs money), and "Skip all, just
 * start the lab" is on every step.
 *
 * Builds into `host`, focusing each step's heading. Diagnostic outcomes go to
 * the analytics call best effort and are also saved in the mastery record.
 */

import {
  answersBody,
  diagnosticQuestions,
  lessonReason,
  planLessons,
  readingTime,
  recordDiagnostic,
  setOverride,
} from './learn-model.js';
import { actionBar, button, focusHeading, lessonCard, make, questionScreen, screenHead, show } from './learn-ui.js';
import { uiIcon } from './icons.js';
import { mountMarkdown } from './markdown.js';

/** The short tag on a lesson that says why it starts the way it does. */
export function reasonChip(reason) {
  if (reason === 'known') return 'You know this';
  if (reason === 'skipped') return 'Skipped';
  if (reason === 'forced') return 'Opened by you';
  if (reason === 'strong') return 'Familiar from your quiz';
  return '';
}

/** "2 lessons open, 1 folded to its recap". */
export function planSummary(plan) {
  const open = plan.filter((p) => p.state === 'expanded').length;
  const folded = plan.length - open;
  if (plan.length === 0) return 'This lab has no lessons.';
  if (open === 0) return 'You already know what this lab needs. Every lesson is a one-line recap.';
  const lessons = (n) => `${n} ${n === 1 ? 'lesson' : 'lessons'}`;
  return folded ? `${lessons(open)} open, ${folded} folded to a recap.` : `${lessons(open)} to read.`;
}

/**
 * Runs the screen.
 *   lab     { slug, title }
 *   entry   { version, learn } as GET /api/learn/:slug returns it
 *   store   the mastery store
 *   post    (body) => Promise, analytics; errors swallowed
 *   onStart ()  => Promise, starts the session; resolves when that attempt is over
 *   onBack  ()  => void, back to the launcher
 * Returns { destroy }.
 */
export function runBeforeYouBegin({ host, lab, entry, store, post, onStart, onBack }) {
  const learn = entry.learn;
  // The steps of this lab's screen, fixed now so the bar does not change length part-way:
  // the story (if it has one), the questions (if any are due), and the plan.
  const stages = [
    ...(learn.story ? ['story'] : []),
    ...(diagnosticQuestions(learn, store.get()).length > 0 ? ['questions'] : []),
    'plan',
  ];
  const steps = (name) => ({ current: stages.indexOf(name) + 1, total: stages.length });
  let cards = [];
  let prose = null;
  let starting = false;
  let gone = false;

  const cleanup = () => {
    for (const c of cards) c.destroy();
    cards = [];
    prose?.destroy();
    prose = null;
  };

  async function start() {
    if (starting || gone) return;
    starting = true;
    const buttons = host.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    const primary = host.querySelector('[data-start="primary"]');
    const original = primary ? [...primary.childNodes].map((n) => n.cloneNode(true)) : [];
    if (primary) {
      primary.textContent = 'Starting…';
      primary.setAttribute('aria-busy', 'true');
    }
    try {
      await onStart();
    } finally {
      starting = false;
      if (!gone && host.isConnected) {
        buttons.forEach((b) => (b.disabled = false));
        if (primary) {
          primary.replaceChildren(...original);
          primary.removeAttribute('aria-busy');
        }
      }
    }
  }

  const skipAll = () => button('Skip all, just start the lab', { kind: 'quiet', onClick: start, id: 'btnSkipAll' });
  const back = () =>
    button('← Back to labs', {
      kind: 'quiet',
      onClick: () => {
        cleanup();
        gone = true;
        onBack();
      },
      id: 'btnBeforeBack',
    });
  const eyebrow = () => `Before you begin · ${lab.title || lab.slug}`;

  // --- story ----------------------------------------------------------------

  function story() {
    cleanup();
    const s = learn.story;
    const more = diagnosticQuestions(learn, store.get()).length > 0 || learn.concepts.length > 0;
    prose = null;
    const body = make('div', 'learn-prose');
    prose = mountMarkdown(body, s.body, { headingLevel: 2 });
    const next = button(more ? 'Continue' : 'Start the lab', {
      kind: 'accent',
      onClick: more ? questions : start,
      id: 'btnStoryNext',
    });
    next.classList.add('btn-lg');
    next.append(uiIcon('arrow', 16));
    if (!more) next.dataset.start = 'primary';
    body.classList.add('story-quote');
    show(
      host,
      screenHead({ eyebrow: eyebrow(), title: s.title, meta: readingTime(s.minutes), badge: 'Case file', steps: steps('story') }),
      body,
      actionBar([next, skipAll(), back()])
    );
    focusHeading(host);
  }

  // --- diagnostic -----------------------------------------------------------

  function questions() {
    cleanup();
    const asked = diagnosticQuestions(learn, store.get());
    if (asked.length === 0) return plan();
    const results = [];
    const step = (i) => {
      cleanup();
      const q = asked[i];
      if (!q) return finishQuestions(asked, results);
      const screen = questionScreen({
        question: q,
        index: i,
        total: asked.length,
        lastLabel: 'See my plan',
        steps: steps('questions'),
        onNext: (r) => {
          results.push(r);
          step(i + 1);
        },
      });
      show(
        host,
        make('p', 'learn-eyebrow learn-eyebrow-top', `${eyebrow()} · A few quick questions set where the lessons start`),
        screen.root,
        actionBar([skipAll(), back()], { label: 'Screen options' })
      );
      focusHeading(host);
    };
    step(0);
  }

  function finishQuestions(asked, results) {
    store.update((m) => recordDiagnostic(m, results));
    try {
      Promise.resolve(post?.(answersBody(results, { phase: 'diagnostic', slug: lab.slug, version: entry.version }))).catch(() => {});
    } catch {
      /* analytics never blocks the plan */
    }
    plan();
  }

  // --- plan -----------------------------------------------------------------

  function plan() {
    cleanup();
    const mastery = store.get();
    const lessons = planLessons(learn, mastery);
    const list = make('div', 'lesson-list');
    const byConcept = new Map(learn.concepts.map((c) => [c.id, c]));

    const refresh = (id, card, focus = true) => {
      const m = store.get();
      const now = planLessons(learn, m).find((p) => p.concept === id);
      card.update({ state: now.state, chip: reasonChip(lessonReason(id, m)) }, { focus });
      summary.textContent = planSummary(planLessons(learn, m));
    };

    const summary = make('p', 'learn-lede plan-summary', planSummary(lessons));
    summary.setAttribute('role', 'status');
    summary.setAttribute('aria-live', 'polite');

    for (const p of lessons) {
      const concept = byConcept.get(p.concept);
      if (!concept) continue;
      const card = lessonCard({
        concept,
        state: p.state,
        mode: 'plan',
        chip: reasonChip(lessonReason(p.concept, mastery)),
        headingTag: 'h2',
        onAction: (action) => {
          store.update((m) => setOverride(m, p.concept, action));
          refresh(p.concept, card);
        },
      });
      cards.push(card);
      list.append(card.root);
    }

    const go = button('Start the lab', { kind: 'accent', onClick: start, id: 'btnStartLab' });
    go.dataset.start = 'primary';
    go.classList.add('learn-start', 'btn-lg');
    go.append(uiIcon('arrow', 16));

    show(
      host,
      screenHead({
        eyebrow: eyebrow(),
        title: 'Your plan for this lab',
        mark: 'this lab',
        meta: 'The questions set where each lesson starts. You decide what to read.',
        steps: steps('plan'),
      }),
      summary,
      list,
      actionBar([go, skipAll(), back()], { sticky: true, label: 'Start' })
    );
    focusHeading(host);
  }

  // --- go -------------------------------------------------------------------

  if (learn.story) story();
  else questions();

  return {
    destroy() {
      gone = true;
      cleanup();
    },
  };
}
