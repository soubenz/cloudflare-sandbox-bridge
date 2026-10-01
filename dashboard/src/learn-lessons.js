/**
 * The lessons of a lab's learn bundle as one list, for the full-screen
 * Lessons step of "Before you begin" (before-you-begin.js). The lessons are
 * read there, before the lab starts, and nowhere else: the session's guide has
 * no Lessons tab.
 *
 * Each lesson is a card, open in full or folded to its recap the way the plan
 * sets it (the diagnostic answers, the platform quiz's levels, and what the
 * learner decided before). "I know this, skip" and "Show me the lesson
 * anyway" are the learner's call on a lesson: it is saved in the mastery
 * record and so is remembered for the next time the lab is started.
 *
 * Builds into a host element with no markup strings, and returns
 * { progress, destroy }; `destroy` stops the diagram players and the observer.
 */

import { lessonReason, planLessons, setOverride } from './learn-model.js';
import { lessonCard, make } from './learn-ui.js';

/** Whether a bundle has any lessons. */
export const hasLessons = (learn) => (learn?.concepts || []).length > 0;

/** The short tag on a lesson that says why it starts the way it does. */
export function reasonChip(reason) {
  if (reason === 'known') return 'You know this';
  if (reason === 'skipped') return 'Skipped';
  if (reason === 'forced') return 'Opened by you';
  if (reason === 'strong') return 'Familiar from your quiz';
  return '';
}

/** "2 lessons open, 1 folded to a recap". */
export function planSummary(plan) {
  const open = plan.filter((p) => p.state === 'expanded').length;
  const folded = plan.length - open;
  if (plan.length === 0) return 'This lab has no lessons.';
  if (open === 0) return 'You already know what this lab needs. Every lesson is a one-line recap.';
  const lessons = (n) => `${n} ${n === 1 ? 'lesson' : 'lessons'}`;
  return folded ? `${lessons(open)} open, ${folded} folded to a recap.` : `${lessons(open)} to read.`;
}

/**
 * The lessons list.
 *
 *   learn       the bundle ({ concepts })
 *   store       the mastery store: it sets how each lesson starts, and takes
 *               the learner's overrides
 *   onPlan      called with [{ concept, state }] now and whenever a lesson is
 *               opened or folded (the screen's summary line is built from it)
 *   onProgress  called with { read, total } now and whenever the count changes
 *
 * A lesson counts as read once the learner has had it on screen, open; one
 * that is folded (they know it, or skipped it) counts as read.
 */
export function buildLessons(host, { learn, store, onPlan, onProgress }) {
  const byConcept = new Map((learn.concepts || []).map((c) => [c.id, c]));
  const cards = new Map();
  const states = new Map();
  const seen = new Set();
  host.replaceChildren();

  const list = make('div', 'lesson-list');
  const mastery = store.get();
  for (const p of planLessons(learn, mastery)) {
    const concept = byConcept.get(p.concept);
    if (!concept) continue;
    const card = lessonCard({
      concept,
      state: p.state,
      chip: reasonChip(lessonReason(p.concept, mastery)),
      headingTag: 'h2',
      onAction: (action) => decide(p.concept, action),
    });
    cards.set(p.concept, card);
    states.set(p.concept, p.state);
    list.append(card.root);
  }
  host.append(list);

  const progress = () => {
    let read = 0;
    for (const [id, state] of states) if (state === 'collapsed' || seen.has(id)) read++;
    return { read, total: states.size };
  };
  let last = null;
  const report = () => {
    const now = progress();
    if (last && last.read === now.read && last.total === now.total) return;
    last = now;
    onProgress?.(now);
  };

  // Read = seen, open. A long lesson is never wholly in view, so a good part of it is enough.
  let observer = null;
  if (cards.size && typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || e.target.dataset.state !== 'expanded') continue;
          if (e.intersectionRatio >= 0.35 || e.intersectionRect.height >= 240) {
            seen.add(e.target.dataset.concept);
            report();
          }
        }
      },
      { threshold: [0, 0.05, 0.1, 0.2, 0.35, 0.6, 1] }
    );
    for (const c of cards.values()) observer.observe(c.root);
  }

  /** The learner's call on a lesson: remembered, and the card and the plan follow. */
  function decide(id, action) {
    store.update((m) => setOverride(m, id, action));
    const m = store.get();
    const plan = planLessons(learn, m);
    const now = plan.find((p) => p.concept === id);
    states.set(id, now.state);
    cards.get(id).update({ state: now.state, chip: reasonChip(lessonReason(id, m)) }, { focus: true });
    // A lesson opened by hand changes size in place, which an observer does not report: look again.
    const root = cards.get(id).root;
    setTimeout(() => {
      observer?.unobserve(root);
      observer?.observe(root);
    }, 0);
    onPlan?.(plan);
    report();
  }

  onPlan?.(planLessons(learn, store.get()));
  report();

  return {
    progress,
    destroy() {
      observer?.disconnect();
      observer = null;
      for (const c of cards.values()) c.destroy();
      host.replaceChildren();
    },
  };
}
