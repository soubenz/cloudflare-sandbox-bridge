/**
 * The lessons of a lab's learn bundle, for the full-screen Lessons step of
 * "Before you begin" (before-you-begin.js). The lessons are read there, before
 * the lab starts, and nowhere else: the session's guide has no Lessons tab.
 *
 * One lesson at a time, and a lesson in short pages (lesson-pages.js cuts them:
 * at `##` headings, `::page` lines and about every 120 words, a diagram or a
 * code block on a page of its own). Each page shows the lesson's title and
 * "Page 2 of 4" with a row of dots. Previous and Next (in the step's action
 * bar), the ← and → keys and a swipe on a touch screen turn the pages, and run
 * on from one lesson to the next; on the last page of the last lesson Next is
 * the step's own button (Continue, Start the lab). The keys and the swipe never
 * leave the step: only that button does. A page turn moves the focus to the
 * page's heading and says "Page n of m" in a polite live region.
 *
 * A lesson is open in full or folded to its recap the way the plan sets it (the
 * diagnostic answers, the platform quiz's levels, and what the learner decided
 * before). "I know this, skip" and "Show me the lesson anyway" are the
 * learner's call on a lesson: it is saved in the mastery record and so is
 * remembered for the next time the lab is started. A folded lesson is one page.
 *
 * Where the learner was (the lesson, its page, the lessons read) is kept in
 * localStorage per lab (`memoryKey`), best effort, so leaving the step and
 * coming back opens the same page.
 *
 * Builds into a host element with no markup strings, and returns
 * { progress, next, prev, destroy }; `destroy` stops the diagram players and the listeners.
 */

import { lessonReason, planLessons, setOverride } from './learn-model.js';
import { button, make } from './learn-ui.js';
import { renderMarkdownNodes } from './markdown.js';
import { clampPage, paginateLesson } from './lesson-pages.js';
import { uiIcon } from './icons.js';
import { QUIZ_LEVELS } from './words.js';

/** Whether a bundle has any lessons. */
export const hasLessons = (learn) => (learn?.concepts || []).length > 0;

/** The short tag on a lesson that says why it starts the way it does. */
export function reasonChip(reason) {
  if (reason === 'known') return 'You know this';
  if (reason === 'skipped') return 'Skipped';
  if (reason === 'forced') return 'Opened by you';
  if (reason === 'strong') return `${QUIZ_LEVELS.strong}, from your quiz`;
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

/** localStorage key of the pager's memory. */
export const PAGES_KEY = 'opalix.lessonPages';

/**
 * The pager's memory for one lab: { at: { [chunk]: concept }, pages: { [concept]: n }, read: [concept] }.
 * Every read and write is best effort: storage that is missing, full or refused reads as empty.
 */
export function lessonMemory(slug, storage = globalThis.localStorage) {
  const readAll = () => {
    try {
      const all = JSON.parse(storage?.getItem(PAGES_KEY) || '{}');
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  };
  const load = () => {
    const mine = slug ? readAll()[slug] : null;
    return {
      at: mine?.at && typeof mine.at === 'object' ? mine.at : {},
      pages: mine?.pages && typeof mine.pages === 'object' ? mine.pages : {},
      read: Array.isArray(mine?.read) ? mine.read.filter((x) => typeof x === 'string') : [],
    };
  };
  return {
    load,
    save(state) {
      if (!slug) return;
      try {
        const all = readAll();
        all[slug] = state;
        storage?.setItem(PAGES_KEY, JSON.stringify(all));
      } catch {
        /* the pager works the same without it */
      }
    },
  };
}

/** Whether a key press belongs to something else on the page (a field, a diagram's own controls). */
const typingIn = (target) =>
  Boolean(target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .diagram, .cm, [role="slider"], [role="tablist"], dialog, [role="dialog"], nav'));

/**
 * The lessons pager.
 *
 *   learn       the bundle ({ concepts })
 *   store       the mastery store: it sets how each lesson starts, and takes
 *               the learner's overrides
 *   onPlan      called with [{ concept, state }] now and whenever a lesson is
 *               opened or folded (the screen's summary line is built from it)
 *   onProgress  called with { read, total } now and whenever the count changes
 *   only        the concept ids this screen shows (one chunk of the lessons: the flow
 *               alternates lessons and questions), in the bundle's order; omitted, all
 *   offset      how many lessons came before (the numbering carries on from it)
 *   nav         where the Previous and Next buttons go (the step's action bar); omitted, under the lesson
 *   finish      the step's own button, shown in place of Next on the last page of the last lesson
 *   memoryKey   the lab's slug: where the learner was is remembered under it (omitted, nothing is)
 *   storage     the storage for that (default localStorage)
 *
 * A lesson counts as read once its last page has been on screen (a one-page lesson
 * as soon as it is shown); one that is folded (they know it, or skipped it) counts as read.
 */
export function buildLessons(host, { learn, store, onPlan, onProgress, only, offset = 0, nav, finish, memoryKey, storage } = {}) {
  const shown = only ? new Set(only) : null;
  const chunk = (plan) => (shown ? plan.filter((p) => shown.has(p.concept)) : plan);
  const byConcept = new Map((learn.concepts || []).map((c) => [c.id, c]));
  const memory = lessonMemory(memoryKey, storage);
  const remembered = memory.load();
  host.replaceChildren();

  const order = [];
  const states = new Map();
  const reasons = new Map();
  const refreshPlan = () => {
    const m = store.get();
    const plan = chunk(planLessons(learn, m)).filter((p) => byConcept.has(p.concept));
    for (const p of plan) {
      states.set(p.concept, p.state);
      reasons.set(p.concept, reasonChip(lessonReason(p.concept, m)));
    }
    return plan;
  };
  for (const p of refreshPlan()) order.push(p.concept);
  const chunkKey = order.join(',');

  const pagesOf = new Map();
  const pages = (id) => {
    if (states.get(id) !== 'expanded') return null;
    if (!pagesOf.has(id)) pagesOf.set(id, paginateLesson(byConcept.get(id).body || ''));
    return pagesOf.get(id);
  };
  const pageCount = (id) => pages(id)?.length ?? 1;

  const read = new Set(remembered.read.filter((id) => states.has(id)));
  const pageMemory = { ...remembered.pages };
  let at = Math.max(0, order.indexOf(remembered.at[chunkKey]));
  let page = order.length ? clampPage(remembered.at[chunkKey] === order[at] ? pageMemory[order[at]] : 0, pageCount(order[at])) : 0;

  // --- the frame: one lesson card, a live region, the buttons ---------------------------------
  const list = make('div', 'lesson-list');
  const live = make('p', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  host.append(list, live);

  const prevBtn = button('', { kind: 'ghost', id: 'btnLessonPrev', onClick: () => turn(-1) });
  const nextBtn = button('', { kind: 'accent', id: 'btnLessonNext', onClick: () => turn(1) });
  prevBtn.classList.add('lesson-nav-prev', 'btn-lg');
  nextBtn.classList.add('lesson-nav-next', 'btn-lg');
  const navBox = make('div', 'lesson-nav');
  navBox.setAttribute('role', 'group');
  navBox.setAttribute('aria-label', 'Lesson pages');
  navBox.append(prevBtn, nextBtn);
  if (finish) navBox.append(finish);
  (nav ?? host).append(navBox);

  let card = null;
  let markdown = null;

  const isLast = () => at === order.length - 1 && page === pageCount(order[at]) - 1;
  const isFirst = () => at === 0 && page === 0;

  /** The labels and visibility of Previous and Next (or the step's button) for where the learner is. */
  const setNav = () => {
    if (!order.length) {
      prevBtn.hidden = nextBtn.hidden = true;
      if (finish) finish.hidden = false;
      return;
    }
    const firstPage = page === 0;
    const lastPage = page === pageCount(order[at]) - 1;
    prevBtn.hidden = isFirst();
    prevBtn.replaceChildren(uiIcon('back', 16), document.createTextNode(firstPage ? 'Previous lesson' : 'Previous'));
    nextBtn.hidden = isLast() && Boolean(finish);
    nextBtn.disabled = isLast() && !finish;
    nextBtn.replaceChildren(document.createTextNode(lastPage && !isLast() ? 'Next lesson' : 'Next'), uiIcon('arrow', 16));
    if (finish) finish.hidden = !isLast();
  };

  const remember = () => {
    const id = order[at];
    if (id) pageMemory[id] = page;
    const before = memory.load();
    // The read lessons of this step are the ones here now; those of the other steps are kept as they were.
    memory.save({ at: { ...before.at, [chunkKey]: id }, pages: pageMemory, read: [...new Set([...before.read.filter((x) => !states.has(x)), ...read])] });
  };

  // --- progress ---------------------------------------------------------------------------------
  const progress = () => {
    let n = 0;
    for (const id of order) if (states.get(id) === 'collapsed' || read.has(id)) n++;
    return { read: n, total: order.length };
  };
  let last = null;
  const report = () => {
    const now = progress();
    if (last && last.read === now.read && last.total === now.total) return;
    last = now;
    onProgress?.(now);
  };

  // --- drawing one page -------------------------------------------------------------------------
  /**
   * Draws lesson `at` on page `page`. `dir` is 'next' or 'prev' for the slide (none on the first
   * draw); `focus` is 'heading' (a page turn), 'toggle' (after the learner's call) or nothing.
   */
  function draw(dir, focus) {
    markdown?.destroy();
    markdown = null;
    if (!order.length) {
      list.replaceChildren();
      setNav();
      return;
    }
    const id = order[at];
    const concept = byConcept.get(id);
    const state = states.get(id);
    const count = pageCount(id);
    page = clampPage(page, count);
    list.style.setProperty('--lesson-offset', String(offset + at));

    const root = make('article', 'lesson');
    root.dataset.concept = id;
    root.dataset.state = state;
    root.dataset.page = String(page + 1);
    root.dataset.pages = String(count);
    root.setAttribute('aria-roledescription', 'lesson');

    const head = make('div', 'lesson-head');
    const title = make('h2', 'lesson-title', concept.title);
    title.tabIndex = -1;
    head.append(title, make('span', 'lesson-meta', `${concept.minutes} min`));
    const chip = reasons.get(id);
    if (chip) head.append(make('span', 'chip lesson-chip', chip));
    const toggle =
      state === 'collapsed'
        ? button('Show me the lesson anyway', { kind: 'quiet', onClick: () => decide(id, 'forced') })
        : button('I know this, skip', { kind: 'ghost', onClick: () => decide(id, 'skipped') });
    toggle.classList.add('lesson-toggle');
    head.append(toggle);
    root.append(head);

    // Where the learner is: "Page 2 of 4", a dot a page, and the lesson's place in this step.
    const where = make('div', 'lesson-where');
    if (count > 1) {
      where.append(make('span', 'lesson-page-label', `Page ${page + 1} of ${count}`));
      const dots = make('span', 'lesson-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (let k = 0; k < count; k++) dots.append(make('i', k < page ? 'done' : k === page ? 'now' : ''));
      where.append(dots);
    }
    if (order.length > 1) where.append(make('span', 'lesson-position', `Lesson ${at + 1} of ${order.length}`));
    if (where.childNodes.length) root.append(where);

    let pageHeading = null;
    if (state === 'collapsed') {
      root.append(make('p', 'lesson-recap', concept.recap));
    } else {
      const body = make('div', 'lesson-body lesson-page');
      const r = renderMarkdownNodes(pages(id)[page]?.blocks ?? [], { headingLevel: 3, diagramOptions: { controls: false } });
      for (const n of r.nodes) body.appendChild(n);
      markdown = r;
      if (dir) body.dataset.enter = dir;
      const firstNode = r.nodes[0];
      if (firstNode && /^H[1-6]$/.test(firstNode.tagName)) pageHeading = firstNode;
      root.append(body);
    }
    list.replaceChildren(root);
    card = root;
    setNav();

    if (page === count - 1 && !read.has(id)) read.add(id);
    remember();
    report();

    afterDraw();

    if (focus === 'toggle') toggle.focus();
    else if (focus === 'heading') {
      const target = pageHeading ?? title;
      if (target !== title) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      // The page starts at its top: the step's head stays where it was, the card's top comes into view.
      if (typeof root.scrollIntoView === 'function' && root.getBoundingClientRect?.().top < 0) root.scrollIntoView({ block: 'start' });
    }
  }

  /**
   * Keeps the page clear of the sticky action bar. The page's own layout fits a diagram in the room above the
   * bar (learn.css); what is left is where the card sits in the scroll: when its body would end under the bar,
   * the screen scrolls on by as much as needed, never more than brings the card's top to the screen's top.
   * (A phone's bar is not sticky: nothing to do.) Runs a frame after a draw, when the card is in the page.
   */
  let destroyed = false;
  function reveal() {
    if (destroyed || !host.isConnected || !card) return;
    const bar = navBox.closest('.learn-actions-sticky');
    const scroller = host.closest('.learn-screen');
    const body = card.querySelector('.lesson-body');
    if (!bar || !scroller || !body || getComputedStyle(bar).position !== 'sticky') return;
    const excess = body.getBoundingClientRect().bottom - (bar.getBoundingClientRect().top - 16);
    const room = card.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + 16);
    const by = Math.min(excess, room);
    if (by >= 1) scroller.scrollTop += by;
  }
  const afterDraw = () => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  };

  /** Says where the learner is now, on the next turn so the same words twice are still said. */
  const announce = (lessonChanged) => {
    const id = order[at];
    const words = `Page ${page + 1} of ${pageCount(id)}`;
    const text = lessonChanged ? `Lesson ${at + 1} of ${order.length}: ${byConcept.get(id).title}. ${words}` : words;
    live.textContent = '';
    setTimeout(() => {
      if (live.isConnected) live.textContent = text;
    }, 50);
  };

  /** One page on (+1) or back (-1), running on into the next or the previous lesson. Never leaves the step. */
  function turn(delta) {
    if (!order.length) return false;
    if (delta > 0) {
      if (page < pageCount(order[at]) - 1) page++;
      else if (at < order.length - 1) {
        at++;
        page = 0;
      } else return false;
    } else {
      if (page > 0) page--;
      else if (at > 0) {
        at--;
        page = pageCount(order[at]) - 1;
      } else return false;
    }
    const lessonChanged = card?.dataset.concept !== order[at];
    draw(delta > 0 ? 'next' : 'prev', 'heading');
    announce(lessonChanged);
    return true;
  }

  /** The learner's call on a lesson: remembered, and the card and the plan follow. */
  function decide(id, action) {
    store.update((m) => setOverride(m, id, action));
    const plan = refreshPlan();
    page = 0;
    pageMemory[id] = 0;
    // Opened again, it is unread until its last page has been on screen.
    if (states.get(id) === 'expanded') read.delete(id);
    draw(null, 'toggle');
    announce(true);
    onPlan?.(plan);
  }

  // --- keys and swipes ----------------------------------------------------------------------------
  const onKey = (event) => {
    if (!host.isConnected || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    if (typingIn(event.target)) return;
    if (turn(event.key === 'ArrowRight' ? 1 : -1)) event.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  let touch = null;
  const onTouchStart = (event) => {
    const t = event.touches?.[0];
    touch = t && event.touches.length === 1 && !(event.target?.closest?.('.diagram, pre, .cm')) ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (event) => {
    const t = event.changedTouches?.[0];
    if (!touch || !t) return;
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
  };
  list.addEventListener('touchstart', onTouchStart, { passive: true });
  list.addEventListener('touchend', onTouchEnd, { passive: true });

  onPlan?.(chunk(planLessons(learn, store.get())));
  draw(null, null);
  report();

  return {
    progress,
    next: () => turn(1),
    prev: () => turn(-1),
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      markdown?.destroy();
      markdown = null;
      navBox.remove();
      host.replaceChildren();
    },
  };
}
