/**
 * "Before you begin": the screen between pressing Start on a lab that has
 * learning content and the session booting.
 *
 *   story  ->  Round 1 (up to 5 questions)  ->  lessons, part A  ->  Round 2  ->  lessons, part B ... ->  Start the lab
 *
 * The questions and the lessons alternate (the order and the rules are `planLearningFlow` in
 * learn-flow.js, which is pure and unit tested; this file draws the steps it returns). The story
 * is read here and the lessons are read here: the session screen has neither. A lab with no
 * questions goes story, lessons, Start; one with no lessons goes story, rounds, Start; one with no
 * story begins at its first round or its lessons.
 *
 * The check decides, the learner overrides: Round 1's diagnostic answers only set the default
 * (a concept answered fully right folds its lesson to a recap, a miss leaves it open). A folded
 * lesson has "Show me the lesson anyway", an open one "I know this, skip", and both are
 * remembered. The session starts only when the lab is started on purpose (a container costs
 * money): "Start the lab" at the end, or "Skip all, just start the lab", which is on every step.
 *
 * Every question gives its feedback at once and is posted to the analytics call best effort, once,
 * the moment it is answered. Going Back never asks a question again: answers are kept (in the
 * flow's own record, `createFlowStore`, so that a refresh comes back to the same step as well).
 *
 * Builds into `host`, focusing each step's heading and saying the step in a polite live region.
 */

import { answersBody, readingTime, recordDiagnostic, isDiagnostic } from './learn-model.js';
import { buildLessons, planSummary } from './learn-lessons.js';
import { createFlowStore, planLearningFlow, questionHeading, restoreSteps, shouldPrefetch, stepIndexFor, stepKindWord, stepLabel, stepNumberFor } from './learn-flow.js';
import { actionBar, button, focusHeading, make, questionScreen, screenHead, show, storyContent } from './learn-ui.js';
import { uiIcon } from './icons.js';

/**
 * Runs the screen.
 *   lab     { slug, title }
 *   entry   { version, learn } as GET /api/learn/:slug returns it
 *   store   the mastery store
 *   post    (body) => Promise, analytics; errors swallowed
 *   onStart ()  => Promise, starts the session; resolves when that attempt is over
 *   onBack  ()  => void, back to the launcher
 *   initial 'story' | 'questions' | 'lessons', the kind of step to open on (a deep link), and
 *   step    its 1-based place in the whole flow (`?step=N`), which wins when it is in range; one out of
 *           range opens the first step, and a kind this lab does not have the closest it does.
 *           Both omitted, the first step.
 *   resume  true when this is a page that was loaded on a step (a refresh or a link): the plan and the
 *           answers of this tab's earlier visit to the lab are then picked up where they were left
 *   onStep  (kind, n) => void, told every time a step comes on screen (kind is the path's word: 'story',
 *           'questions' or 'lessons'; n the step's number, null when the word alone names it), so the
 *           address bar can follow
 *   flowStore  where the visit is kept (default: createFlowStore, sessionStorage)
 *   prepare        () => Promise, warms the lab's container up. Called ONCE per visit, the first time the
 *                  second-to-last step (`prefetchStepIndex`) or a later one comes on screen, never for
 *                  "Skip all" (that starts at once). Fire and forget: a failure is swallowed and Start works
 *                  the same, only slower. Nothing about it is shown.
 *   cancelPrepare  ({beacon}) => void, drops the warm lab when the visit ends without Start (Back to labs, a
 *                  route change, the page closing with `beacon: true`). Not called once Start was pressed.
 * Returns { steps, goto(kind, n), destroy }: goto shows a step the way `initial` and `step` do (the browser's Back and Forward).
 */
export function runBeforeYouBegin({ host, lab, entry, store, post, onStart, onBack, initial, step: initialStep, onStep, resume = false, flowStore, prepare, cancelPrepare }) {
  const learn = entry.learn;
  const flow = flowStore ?? createFlowStore({ slug: lab.slug, version: entry.version });
  const questionById = new Map(learn.questions.map((q) => [q.id, q]));

  // The plan is fixed now so the dots do not change length part-way: a refresh picks up the saved one.
  const saved = resume ? flow.load() : null;
  const restored = saved ? restoreSteps(learn, saved.steps) : null;
  const steps = restored ?? planLearningFlow(learn, store.get());
  const answers = new Map(restored ? Object.entries(saved.answers).filter(([id]) => questionById.has(id)) : []);
  const persist = () => flow.save(steps, Object.fromEntries(answers));
  persist();

  const kinds = steps.map((s) => s.kind);
  const dots = (i) => ({ current: i + 1, kinds });
  const masteryRound = steps.find((s) => s.kind === 'round') ?? null;
  let index = 0;
  let lessons = null;
  let prose = null;
  let starting = false;
  let gone = false;
  // The warm lab: asked for once per visit, and kept only until Start is pressed (the API then hands it over).
  let prepared = false;
  let startPressed = false;
  const leaving = () => {
    if (prepared && !startPressed) cancelPrepare?.({ beacon: true });
  };

  /** Warms the lab up the first time the second-to-last step (or a later one) is shown. Once per visit, silent. */
  const maybePrepare = (i) => {
    if (prepared || gone || !prepare || !shouldPrefetch(steps, i)) return;
    prepared = true;
    // A closing tab cannot await anything: the beacon is sent from here, and the API ignores it for a lab that has begun.
    globalThis.addEventListener?.('pagehide', leaving);
    try {
      Promise.resolve(prepare()).catch(() => {});
    } catch {
      /* a failed warm-up never blocks the flow */
    }
  };

  // Said to screen readers on every step; the heading takes focus too, this names the step among the others.
  const live = make('p', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  host.before(live);
  const announce = (i) => {
    live.textContent = '';
    // Set on the next turn so the same words said twice are still said.
    setTimeout(() => {
      if (!gone) live.textContent = `Step ${i + 1} of ${steps.length}: ${stepLabel(steps[i], learn)}`;
    }, 50);
  };

  const cleanup = () => {
    lessons?.destroy();
    lessons = null;
    prose?.destroy();
    prose = null;
    host.classList.remove('learn-wrap-comic', 'learn-wrap-lessons', 'learn-wrap-round');
  };

  async function start() {
    if (starting || gone) return;
    starting = true;
    // From here the start itself takes over the warm lab; leaving no longer cancels it (a failed start undoes this).
    startPressed = true;
    const buttons = host.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    const primary = host.querySelector('[data-start="primary"]');
    const original = primary ? [...primary.childNodes].map((n) => n.cloneNode(true)) : [];
    if (primary) {
      primary.textContent = 'Starting…';
      primary.setAttribute('aria-busy', 'true');
    }
    try {
      const started = await onStart();
      // The app resolves true once the session is up; false (could not start) or nothing (the desktop notice) leaves the warm lab ours to drop.
      if (!started) startPressed = false;
    } catch (err) {
      startPressed = false;
      throw err;
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
  const backToLabs = () =>
    button('← Back to labs', {
      kind: 'quiet',
      onClick: () => {
        cleanup();
        gone = true;
        flow.clear();
        onBack();
      },
      id: 'btnBeforeBack',
    });
  const eyebrow = () => `Before you begin · ${lab.title || lab.slug}`;

  /** The button back to step `i - 1`, named for what is there; null on the first step. */
  const backStep = () => {
    const prev = steps[index - 1];
    if (!prev) return null;
    const to = index - 1;
    if (prev.kind === 'story') return button('← Back to the story', { kind: 'quiet', onClick: () => enterStep(to, 'back'), id: 'btnBackStory' });
    if (prev.kind === 'round') return button('← Back to the questions', { kind: 'quiet', onClick: () => enterStep(to, 'back'), id: 'btnBackQuestions' });
    return button('← Back to the lessons', { kind: 'quiet', onClick: () => enterStep(to, 'back'), id: 'btnBackLessons' });
  };

  /** Tells the page a step is on screen: the live region, and the address bar through `onStep`. */
  const arrived = (i) => {
    maybePrepare(i);
    announce(i);
    onStep?.(stepKindWord(steps[i]), stepNumberFor(steps, i));
  };

  // --- story ----------------------------------------------------------------

  function story(i) {
    cleanup();
    const s = learn.story ?? { title: learn.comic.title, minutes: 0 };
    const more = i + 1 < steps.length;
    // The motion comic when the lab has one, with the text story folded under it; the text alone otherwise.
    prose = storyContent(learn, { headingLevel: 2 });
    const body = prose.node;
    host.classList.toggle('learn-wrap-comic', prose.hasComic);
    // Whether the comic has ended, was skipped or never played, Continue is how the learner moves on:
    // the story is not taken away from them (nor from a learner who asked for reduced motion, for whom it starts finished).
    const next = button(more ? 'Continue' : 'Start the lab', {
      kind: 'accent',
      onClick: more ? () => enterStep(i + 1, 'forward') : start,
      id: 'btnStoryNext',
    });
    next.classList.add('btn-lg');
    next.append(uiIcon('arrow', 16));
    if (!more) next.dataset.start = 'primary';
    show(
      host,
      screenHead({ eyebrow: eyebrow(), title: s.title, meta: readingTime(s.minutes), badge: 'Case file', steps: dots(i) }),
      body,
      actionBar([next, skipAll(), backToLabs()])
    );
    arrived(i);
    focusHeading(host);
  }

  // --- a round of questions ---------------------------------------------------

  /** Records one answer: kept for Back and a refresh, posted once, and (Round 1) it sets mastery as the old block did. */
  function answered(step, result) {
    if (answers.has(result.question_id)) return;
    answers.set(result.question_id, result);
    persist();
    try {
      Promise.resolve(post?.(answersBody([result], { phase: 'diagnostic', slug: lab.slug, version: entry.version }))).catch(() => {});
    } catch {
      /* analytics never blocks the questions */
    }
    if (step === masteryRound) {
      // Every diagnostic answer of the round so far, as one block: a concept is known when all of them were right.
      const given = step.questions.filter((id) => isDiagnostic(questionById.get(id)) && answers.has(id)).map((id) => answers.get(id));
      store.update((m) => recordDiagnostic(m, given));
    }
  }

  /** Round step `i`, on question `at` (a number), 'open' (the first unanswered, else the last) or 'last'. */
  function round(i, at, entering = true) {
    cleanup();
    host.classList.add('learn-wrap-round');
    const step = steps[i];
    const total = step.questions.length;
    let qi = at;
    if (at === 'last') qi = total - 1;
    else if (at === 'open') {
      qi = step.questions.findIndex((id) => !answers.has(id));
      if (qi < 0) qi = total - 1;
    }
    const q = questionById.get(step.questions[qi]);
    const lastQuestion = qi === total - 1;
    const after = steps[i + 1];
    const screen = questionScreen({
      question: q,
      index: qi,
      total,
      title: questionHeading(step, qi),
      lastLabel: !after ? 'Start the lab' : after.kind === 'lessons' ? 'See the lessons' : 'Next questions',
      steps: dots(i),
      answered: answers.get(q.id),
      onAnswer: (result) => answered(step, result),
      onNext: () => {
        if (!lastQuestion) return round(i, qi + 1, false);
        if (after) return enterStep(i + 1, 'forward');
        return start();
      },
    });
    if (lastQuestion && !after) screen.next.dataset.start = 'primary';
    const back = qi > 0 ? button('← Previous question', { kind: 'quiet', onClick: () => round(i, qi - 1, false), id: 'btnPrevQuestion' }) : backStep();
    const lead = step.round === 1 && masteryRound === step ? 'A few quick questions set where the lessons start' : 'A few questions on what you just read';
    show(host, make('p', 'learn-eyebrow learn-eyebrow-top', `${eyebrow()} · ${lead}`), screen.root, actionBar([skipAll(), ...(back ? [back] : []), backToLabs()], { label: 'Screen options' }));
    if (entering) arrived(i);
    focusHeading(host);
  }

  // --- lessons --------------------------------------------------------------

  /** One chunk of the lessons, full screen: the whole width of the console, then on to the next step or Start the lab. */
  function lessonsStep(i) {
    cleanup();
    host.classList.add('learn-wrap-lessons');
    const step = steps[i];
    const after = steps[i + 1];
    // The numbering of the lessons carries on from the chunks before this one.
    const offset = steps.slice(0, i).reduce((n, s) => n + (s.kind === 'lessons' ? s.concepts.length : 0), 0);

    const summary = make('p', 'learn-lede plan-summary');
    summary.setAttribute('role', 'status');
    summary.setAttribute('aria-live', 'polite');
    const tally = make('p', 'lessons-tally');
    const list = make('section', 'learn-lessons');
    list.setAttribute('aria-label', step.parts > 1 ? `Lessons, part ${step.part} of ${step.parts}` : 'Lessons');
    lessons = buildLessons(list, {
      learn,
      store,
      only: step.concepts,
      offset,
      onPlan: (plan) => {
        summary.textContent = planSummary(plan);
      },
      onProgress: ({ read, total }) => {
        tally.textContent = total ? `${read} of ${total} ${total === 1 ? 'lesson' : 'lessons'} read` : '';
      },
    });

    const go = after
      ? button('Continue to the questions', { kind: 'accent', onClick: () => enterStep(i + 1, 'forward'), id: 'btnNextStep' })
      : button('Start the lab', { kind: 'accent', onClick: start, id: 'btnStartLab' });
    if (!after) go.dataset.start = 'primary';
    go.classList.add('learn-start', 'btn-lg');
    go.append(uiIcon('arrow', 16));
    const back = backStep();

    const several = step.parts > 1;
    show(
      host,
      screenHead({
        eyebrow: eyebrow(),
        title: several ? `Lessons, part ${step.part} of ${step.parts}` : 'Lessons for this lab',
        mark: several ? undefined : 'this lab',
        meta: several ? 'A few lessons, then a few more questions. You decide what to read.' : 'The questions set where each lesson starts. You decide what to read.',
        steps: dots(i),
      }),
      summary,
      list,
      actionBar([go, ...(back ? [back] : []), skipAll(), backToLabs(), tally], { sticky: true, label: after ? 'Next' : 'Start' })
    );
    arrived(i);
    focusHeading(host);
  }

  // --- go -------------------------------------------------------------------

  /** Shows step `i`. `how` is 'forward', 'back' (a round then opens on its last question) or 'route'. */
  function enterStep(i, how) {
    if (gone) return;
    index = Math.max(0, Math.min(i, steps.length - 1));
    const step = steps[index];
    if (step.kind === 'story') return story(index);
    if (step.kind === 'round') return round(index, how === 'back' ? 'last' : 'open');
    return lessonsStep(index);
  }

  enterStep(stepIndexFor(steps, initial, initialStep), 'route');

  return {
    steps,
    goto: (kind, n) => enterStep(stepIndexFor(steps, kind, n), 'route'),
    destroy() {
      gone = true;
      globalThis.removeEventListener?.('pagehide', leaving);
      // Left without starting (or the lab did not start): the warm container is not wanted.
      if (prepared && !startPressed) cancelPrepare?.({ beacon: false });
      cleanup();
      live.remove();
      // The visit is over (the lab started, or the learner left): the next one plans afresh.
      flow.clear();
    },
  };
}
