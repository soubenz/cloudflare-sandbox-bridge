/**
 * "Before you begin": the screen between pressing Start on a lab that has
 * learning content and the session booting.
 *
 *   story  ->  diagnostic questions (only for concepts not already known)
 *          ->  the lessons, full screen: each open in full or folded to its recap
 *          ->  Start the lab
 *
 * This is the only place the story and the lessons are read: the session
 * screen has neither. A lab with no lessons goes from its story straight to
 * Start; one with no story begins at its questions or its lessons.
 *
 * The check decides, the learner overrides: the questions only set the
 * default. A folded lesson has "Show me the lesson anyway", an open one "I
 * know this, skip", and both are remembered. The session starts only when
 * "Start the lab" is pressed (a container costs money), and "Skip all, just
 * start the lab" is on every step.
 *
 * Builds into `host`, focusing each step's heading and saying the step in a
 * polite live region. Diagnostic outcomes go to the analytics call best
 * effort and are also saved in the mastery record.
 */

import { answersBody, diagnosticQuestions, readingTime, recordDiagnostic } from './learn-model.js';
import { buildLessons, hasLessons, planSummary } from './learn-lessons.js';
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
 * Returns { destroy }.
 */
export function runBeforeYouBegin({ host, lab, entry, store, post, onStart, onBack }) {
  const learn = entry.learn;
  const hasStory = Boolean(learn.story || learn.comic);
  const lessonsAhead = hasLessons(learn);
  // The steps of this lab's screen, fixed now so the bar does not change length part-way:
  // the story (if it has one), the questions (if any are due), and the lessons (if it has any).
  const questionsDue = diagnosticQuestions(learn, store.get()).length > 0;
  const stages = [
    ...(hasStory ? ['story'] : []),
    ...(questionsDue ? ['questions'] : []),
    ...(lessonsAhead || questionsDue || !hasStory ? ['lessons'] : []),
  ];
  const steps = (name) => ({ current: stages.indexOf(name) + 1, total: stages.length });
  let lessons = null;
  let prose = null;
  let diagnosed = false;
  let starting = false;
  let gone = false;

  // Said to screen readers on every step; the heading takes focus too, this names the step among the others.
  const live = make('p', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  host.before(live);
  const announce = (name, label) => {
    live.textContent = '';
    // Set on the next turn so the same words said twice are still said.
    setTimeout(() => {
      if (!gone) live.textContent = `Step ${steps(name).current} of ${stages.length}: ${label}`;
    }, 50);
  };

  const cleanup = () => {
    lessons?.destroy();
    lessons = null;
    prose?.destroy();
    prose = null;
    host.classList.remove('learn-wrap-comic', 'learn-wrap-lessons');
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
    const s = learn.story ?? { title: learn.comic.title, minutes: 0 };
    const more = diagnosticQuestions(learn, store.get()).length > 0 || lessonsAhead;
    // The motion comic when the lab has one, with the text story folded under it; the text alone otherwise.
    prose = storyContent(learn, { headingLevel: 2 });
    const body = prose.node;
    host.classList.toggle('learn-wrap-comic', prose.hasComic);
    // Whether the comic has ended, was skipped or never played, Continue is how the learner moves on:
    // the story is not taken away from them (nor from a learner who asked for reduced motion, for whom it starts finished).
    const next = button(more ? 'Continue' : 'Start the lab', {
      kind: 'accent',
      onClick: more ? questions : start,
      id: 'btnStoryNext',
    });
    next.classList.add('btn-lg');
    next.append(uiIcon('arrow', 16));
    if (!more) next.dataset.start = 'primary';
    show(
      host,
      screenHead({ eyebrow: eyebrow(), title: s.title, meta: readingTime(s.minutes), badge: 'Case file', steps: steps('story') }),
      body,
      actionBar([next, skipAll(), back()])
    );
    announce('story', s.title);
    focusHeading(host);
  }

  // --- diagnostic -----------------------------------------------------------

  function questions() {
    cleanup();
    // Asked once per visit to this screen: coming back from the lessons to the story does not ask them again.
    const asked = diagnosed ? [] : diagnosticQuestions(learn, store.get());
    if (asked.length === 0) return lessonsStep();
    const results = [];
    const step = (i) => {
      cleanup();
      const q = asked[i];
      if (!q) return finishQuestions(asked, results);
      const screen = questionScreen({
        question: q,
        index: i,
        total: asked.length,
        lastLabel: 'See the lessons',
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
      if (i === 0) announce('questions', 'A few quick questions');
      focusHeading(host);
    };
    step(0);
  }

  function finishQuestions(asked, results) {
    diagnosed = true;
    store.update((m) => recordDiagnostic(m, results));
    try {
      Promise.resolve(post?.(answersBody(results, { phase: 'diagnostic', slug: lab.slug, version: entry.version }))).catch(() => {});
    } catch {
      /* analytics never blocks the lessons */
    }
    lessonsStep();
  }

  // --- lessons --------------------------------------------------------------

  /** The lessons, full screen: the whole width of the console, then Start the lab. */
  function lessonsStep() {
    cleanup();
    host.classList.add('learn-wrap-lessons');

    const summary = make('p', 'learn-lede plan-summary');
    summary.setAttribute('role', 'status');
    summary.setAttribute('aria-live', 'polite');
    const tally = make('p', 'lessons-tally');
    const list = make('section', 'learn-lessons');
    list.setAttribute('aria-label', 'Lessons');
    lessons = buildLessons(list, {
      learn,
      store,
      onPlan: (plan) => {
        summary.textContent = planSummary(plan);
      },
      onProgress: ({ read, total }) => {
        tally.textContent = total ? `${read} of ${total} ${total === 1 ? 'lesson' : 'lessons'} read` : '';
      },
    });

    const go = button('Start the lab', { kind: 'accent', onClick: start, id: 'btnStartLab' });
    go.dataset.start = 'primary';
    go.classList.add('learn-start', 'btn-lg');
    go.append(uiIcon('arrow', 16));
    const toStory = hasStory ? [button('← Back to the story', { kind: 'quiet', onClick: story, id: 'btnBackStory' })] : [];

    show(
      host,
      screenHead({
        eyebrow: eyebrow(),
        title: 'Lessons for this lab',
        mark: 'this lab',
        meta: 'The questions set where each lesson starts. You decide what to read.',
        steps: steps('lessons'),
      }),
      summary,
      list,
      actionBar([go, ...toStory, skipAll(), back(), tally], { sticky: true, label: 'Start' })
    );
    announce('lessons', 'Lessons');
    focusHeading(host);
  }

  // --- go -------------------------------------------------------------------

  if (hasStory) story();
  else questions();

  return {
    destroy() {
      gone = true;
      cleanup();
      live.remove();
    },
  };
}
