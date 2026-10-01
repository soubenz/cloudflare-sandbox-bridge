/**
 * What a running lab's guide shows of the lab's learn bundle.
 *
 *   Story    the case file, as text (an explore lab opens on it)
 *   Lessons  every lesson with its diagrams, open or folded the way the plan
 *            set them and toggleable at any time
 *
 * A lab that does not open on its story (a build lab) gets the story folded
 * into the top of its Lessons tab, so nothing it ships goes missing. Toggling a
 * lesson here only changes what is showing; what the learner decided on the
 * Before you begin screen is the record, and is not touched.
 *
 * Both build into a host element with no markup strings, and return
 * { destroy } which stops the diagram players.
 */

import { lessonReason, planLessons, readingTime } from './learn-model.js';
import { reasonChip } from './before-you-begin.js';
import { lessonCard, make } from './learn-ui.js';
import { mountMarkdown } from './markdown.js';

/** Whether a bundle has a story / lessons / anything for the guide's learning tabs. */
export const hasStory = (learn) => Boolean(learn?.story);
export const hasLessons = (learn) => (learn?.concepts || []).length > 0;
export const hasLearnContent = (learn) => hasStory(learn) || hasLessons(learn);

/** The story section: its title, reading time and text (with the case file's drop cap). */
function storySection(learn) {
  const section = make('section', 'learn-story');
  section.setAttribute('aria-labelledby', 'learnStoryTitle');
  const title = make('h2', 'learn-story-title', learn.story.title);
  title.id = 'learnStoryTitle';
  section.append(title);
  const meta = readingTime(learn.story.minutes);
  if (meta) section.append(make('p', 'learn-meta', meta));
  const body = make('div', 'learn-prose story-quote');
  const markdown = mountMarkdown(body, learn.story.body, { headingLevel: 3 });
  section.append(body);
  return { section, markdown };
}

/** The Story tab. */
export function buildStoryTab(host, { learn }) {
  host.replaceChildren();
  const { section, markdown } = storySection(learn);
  host.append(section);
  return {
    destroy() {
      markdown.destroy();
      host.replaceChildren();
    },
  };
}

/**
 * The Lessons tab.
 *
 *   withStory   put the story above the lessons (a lab whose guide has no Story tab)
 *   onProgress  called with { read, total } whenever the count changes
 *
 * A lesson counts as read once the learner has had it on screen, open; one the
 * plan folded because they already know it counts from the start. The count
 * is for this session only, like the open and folded state.
 *
 * Returns { destroy, progress() }.
 */
export function buildLessonsTab(host, { learn, mastery, withStory = false, onProgress }) {
  const cards = [];
  const read = new Set();
  let story = null;
  host.replaceChildren();

  if (withStory && hasStory(learn)) {
    const built = storySection(learn);
    story = built.markdown;
    host.append(built.section);
  }

  const lessons = hasLessons(learn) ? planLessons(learn, mastery) : [];
  const byConcept = new Map((learn.concepts || []).map((c) => [c.id, c]));
  let list = null;
  if (lessons.length) {
    const section = make('section', 'learn-lessons');
    section.setAttribute('aria-labelledby', 'learnLessonsTitle');
    const title = make('h2', 'learn-lessons-title', 'Lessons');
    title.id = 'learnLessonsTitle';
    section.append(title, make('p', 'learn-meta', 'A folded lesson shows its recap. Open any lesson at any time.'));
    list = make('div', 'lesson-list');
    for (const p of lessons) {
      const concept = byConcept.get(p.concept);
      if (!concept) continue;
      const card = lessonCard({
        concept,
        state: p.state,
        mode: 'tab',
        chip: reasonChip(lessonReason(p.concept, mastery)),
        headingTag: 'h3',
      });
      cards.push(card);
      if (p.state === 'collapsed') read.add(p.concept);
      list.append(card.root);
    }
    section.append(list);
    host.append(section);
  }

  const total = cards.length;
  const progress = () => ({ read: read.size, total });
  const markRead = (id) => {
    if (read.has(id)) return;
    read.add(id);
    onProgress?.(progress());
  };

  // Read = seen, open. A long lesson is never wholly in view, so a good part of it is enough.
  let observer = null;
  if (total && typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || e.target.dataset.state !== 'expanded') continue;
          if (e.intersectionRatio >= 0.35 || e.intersectionRect.height >= 240) markRead(e.target.dataset.concept);
        }
      },
      { threshold: [0, 0.05, 0.1, 0.2, 0.35, 0.6, 1] }
    );
    for (const c of cards) observer.observe(c.root);
    // A lesson opened by hand changes size in place, which an observer does not report: look again.
    list?.addEventListener('click', (event) => {
      const root = event.target instanceof Element ? event.target.closest('.lesson') : null;
      if (!root) return;
      setTimeout(() => {
        observer?.unobserve(root);
        observer?.observe(root);
      }, 0);
    });
  }
  onProgress?.(progress());

  return {
    progress,
    destroy() {
      observer?.disconnect();
      observer = null;
      story?.destroy();
      for (const c of cards) c.destroy();
      host.replaceChildren();
    },
  };
}
