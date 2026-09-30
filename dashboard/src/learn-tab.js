/**
 * The "Learn" tab of a running lab: the story, then every lesson with its
 * diagrams, open or folded the way the plan set them and toggleable at any
 * time. Toggling here only changes what is showing; what the learner decided
 * on the Before you begin screen is the record, and is not touched.
 *
 * Builds into `host` (the tab's article) with no markup strings; returns
 * { destroy } which stops the diagram players.
 */

import { lessonReason, planLessons, readingTime } from './learn-model.js';
import { reasonChip } from './before-you-begin.js';
import { lessonCard, make } from './learn-ui.js';
import { mountMarkdown } from './markdown.js';

/** Whether a bundle has anything for the Learn tab. */
export const hasLearnContent = (learn) => Boolean(learn && (learn.story || (learn.concepts || []).length > 0));

export function buildLearnTab(host, { learn, mastery }) {
  const cards = [];
  let story = null;
  host.replaceChildren();

  if (learn.story) {
    const section = make('section', 'learn-story');
    section.setAttribute('aria-labelledby', 'learnStoryTitle');
    const title = make('h2', 'learn-story-title', learn.story.title);
    title.id = 'learnStoryTitle';
    section.append(title);
    const meta = readingTime(learn.story.minutes);
    if (meta) section.append(make('p', 'learn-meta', meta));
    const body = make('div', 'learn-prose');
    story = mountMarkdown(body, learn.story.body, { headingLevel: 3 });
    section.append(body);
    host.append(section);
  }

  if ((learn.concepts || []).length > 0) {
    const plan = planLessons(learn, mastery);
    const byConcept = new Map(learn.concepts.map((c) => [c.id, c]));
    const section = make('section', 'learn-lessons');
    section.setAttribute('aria-labelledby', 'learnLessonsTitle');
    const title = make('h2', 'learn-lessons-title', 'Lessons');
    title.id = 'learnLessonsTitle';
    section.append(title, make('p', 'learn-meta', 'A folded lesson shows its recap. Open any lesson at any time.'));
    const list = make('div', 'lesson-list');
    for (const p of plan) {
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
      list.append(card.root);
    }
    section.append(list);
    host.append(section);
  }

  return {
    destroy() {
      story?.destroy();
      for (const c of cards) c.destroy();
      host.replaceChildren();
    },
  };
}
