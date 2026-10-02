/**
 * Awards: how they look (the badge, the shelf, the small badges on Home), and the moment one is earned
 * (a toast, and a line on the lab's result card).
 *
 * Everything comes in through textContent: an award's title and description are the service's words, never
 * markup. An award's tier (bronze, silver, gold) is drawn from the design tokens (profile.css) and is also
 * said in words, so colour never carries it alone.
 */
import { svgIcon } from './icons.js';
import { ICONS } from './launcher-model.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 24px stroke glyphs for the `icon` names an award carries. The three the launcher already draws are reused. */
const AWARD_ICONS = {
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2.2 4L16 12H5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  feather: '<path d="M20.2 3.8c-6-1-12 2-13.6 8.2L5 19"/><path d="M20.2 3.8c1 6-2 12-8.2 13.6"/><path d="M5 19l9-9"/>',
  stack: ICONS.stack,
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5.5A2.5 2.5 0 0 0 8 10M16 6h2.5A2.5 2.5 0 0 1 16 10"/><path d="M12 13v4M8.5 20h7M10 17h4"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.2 1 2 2 2 0-3-.5-5 1-8z"/>',
  bolt: ICONS.bolt,
  refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
  puzzle: '<path d="M10 4a2 2 0 0 1 4 0v2h4v4h-2a2 2 0 0 0 0 4h2v4h-4v-2a2 2 0 0 0-4 0v2H6v-4h2a2 2 0 0 0 0-4H6V6h4z"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 11 6 3h4l2 4 2-4h4l-2.5 8"/>',
  compass: ICONS.compass,
};

/** A glyph for an award's icon name; a star for one this console does not know. */
export function awardIcon(name, size = 22) {
  return svgIcon(AWARD_ICONS[name] ?? AWARD_ICONS.star, size);
}

export const TIERS = ['bronze', 'silver', 'gold'];
const tierOf = (tier) => (TIERS.includes(tier) ? tier : 'bronze');
/** "Gold", said in words wherever a tier is drawn. */
export const tierLabel = (tier) => {
  const t = tierOf(tier);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "3 Jan 2026". Empty for a time that is not one. */
export function awardDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The round badge: the award's glyph inside a ring in its tier's colour. Decoration; the words are next to it. */
export function awardBadge(award, size = 22) {
  const badge = el('span', 'award-badge');
  badge.dataset.tier = tierOf(award?.tier);
  badge.setAttribute('aria-hidden', 'true');
  badge.append(awardIcon(award?.icon, size));
  return badge;
}

/** An earned award on the shelf: badge, title, what it was for, its tier in words, and the day. */
export function earnedCard(award) {
  const li = el('li', 'award-card');
  li.dataset.award = award.id;
  li.dataset.tier = tierOf(award.tier);
  li.dataset.state = 'earned';
  const text = el('div', 'award-text');
  const title = el('h4', 'award-title', award.title);
  const meta = el('p', 'award-meta');
  meta.append(el('span', 'award-tier', `${tierLabel(award.tier)} award`));
  const date = awardDate(award.earned_at);
  if (date) {
    const time = el('time', '', date);
    time.dateTime = new Date(award.earned_at).toISOString();
    meta.append(document.createTextNode(' · Earned '), time);
  }
  text.append(title, el('p', 'award-desc', award.description), meta);
  li.append(awardBadge(award, 26), text);
  return li;
}

/** A locked award: the same card, drawn quiet, with how far along the learner is as `have/need`. */
export function lockedCard(award) {
  const li = el('li', 'award-card');
  li.dataset.award = award.id;
  li.dataset.tier = tierOf(award.tier);
  li.dataset.state = 'locked';
  const text = el('div', 'award-text');
  const title = el('h4', 'award-title', award.title);
  const have = Math.max(0, Number(award.progress?.have) || 0);
  const need = Math.max(1, Number(award.progress?.need) || 1);
  const shown = Math.min(have, need);
  const meta = el('p', 'award-meta');
  meta.append(el('span', 'award-tier', `${tierLabel(award.tier)} award`), document.createTextNode(' · Not earned yet'));
  const meter = el('div', 'award-progress');
  const bar = el('span', 'award-meter');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', `Progress towards ${award.title}`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(need));
  bar.setAttribute('aria-valuenow', String(shown));
  bar.setAttribute('aria-valuetext', `${shown} of ${need}`);
  const fill = document.createElement('i');
  fill.style.width = `${Math.round((shown / need) * 100)}%`;
  bar.append(fill);
  meter.append(bar, el('span', 'award-count', `${shown}/${need}`));
  text.append(title, el('p', 'award-desc', award.description), meta, meter);
  li.append(awardBadge(award, 26), text);
  return li;
}

/**
 * The Awards section's body: the earned ones first (newest first, as given), then the locked, quiet. Either list
 * may be empty; an empty shelf says how to fill it.
 */
export function awardsShelf(awards) {
  const earned = Array.isArray(awards?.earned) ? awards.earned : [];
  const locked = Array.isArray(awards?.locked) ? awards.locked : [];
  const root = el('div', 'awards');

  const got = el('section', 'awards-group');
  got.setAttribute('aria-labelledby', 'awardsEarnedHeading');
  const gotHead = el('h3', 'awards-subhead', `Earned (${earned.length})`);
  gotHead.id = 'awardsEarnedHeading';
  got.append(gotHead);
  if (earned.length) {
    const list = el('ul', 'award-list');
    list.id = 'awardsEarned';
    for (const a of earned) list.append(earnedCard(a));
    got.append(list);
  } else {
    got.append(el('p', 'awards-empty', 'No awards yet. Finish a lab to earn your first one.'));
  }
  root.append(got);

  if (locked.length) {
    const to = el('section', 'awards-group');
    to.setAttribute('aria-labelledby', 'awardsLockedHeading');
    const toHead = el('h3', 'awards-subhead', `Still to earn (${locked.length})`);
    toHead.id = 'awardsLockedHeading';
    const list = el('ul', 'award-list');
    list.id = 'awardsLocked';
    for (const a of locked) list.append(lockedCard(a));
    to.append(toHead, list);
    root.append(to);
  }
  return root;
}

/** A small badge for Home: the glyph and the title, with the tier in words for a screen reader. */
export function miniAward(award) {
  const li = el('li', 'mini-award');
  li.dataset.award = award.id;
  li.dataset.tier = tierOf(award.tier);
  li.append(awardBadge(award, 18));
  const name = el('span', 'mini-award-title');
  name.append(el('span', 'sr-only', `${tierLabel(award.tier)} award: `), document.createTextNode(award.title));
  li.append(name);
  return li;
}

// ------------------------------------------------------------------ the moment

const CONFETTI_COLORS = ['--good', '--accent', '--warn', '--bad'];

/** About twenty CSS-animated pieces, as the lab's result card has them; gone after 1.5s. The caller checked reduced motion. */
function confetti(host) {
  const box = el('div', 'confetti');
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 20; i++) {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${5 + Math.random() * 90}%`);
    piece.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 80)}px`);
    piece.style.setProperty('--r', `${Math.round(Math.random() * 720 - 360)}deg`);
    piece.style.setProperty('--d', `${Math.round(Math.random() * 200)}ms`);
    piece.style.setProperty('--c', `var(${CONFETTI_COLORS[i % CONFETTI_COLORS.length]})`);
    box.append(piece);
  }
  host.append(box);
  setTimeout(() => box.remove(), 1500);
}

/**
 * The award toast. One polite live region holds every toast, so a screen reader says "Award earned: First
 * steps, bronze" once, without taking focus. It is made when this is created, before any toast goes into it,
 * so the first one is announced too. Confetti only when the learner has not asked for reduced motion.
 *
 *   const toasts = createAwardToasts({ reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches });
 *   toasts.show({ id, title, tier });
 */
export function createAwardToasts({ reducedMotion = () => false, ms = 9000, parent = document.body } = {}) {
  const live = el('div', 'award-toasts');
  live.id = 'awardToasts';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-relevant', 'additions');
  parent.append(live);

  return {
    live,
    show(award) {
      if (!award || typeof award.title !== 'string' || !award.title) return null;
      const tier = tierOf(award.tier);
      const toast = el('div', 'award-toast');
      toast.dataset.tier = tier;
      toast.dataset.award = String(award.id ?? '');
      toast.append(awardBadge({ ...award, tier }, 26));
      const text = el('div', 'award-toast-text');
      text.append(el('p', 'award-toast-eyebrow', 'Award earned'), el('p', 'award-toast-title', award.title), el('p', 'award-toast-tier', `${tierLabel(tier)} award`));
      const close = el('button', 'btn btn-tiny btn-ghost btn-icon', '×');
      close.type = 'button';
      close.setAttribute('aria-label', `Dismiss: ${award.title}`);
      let timer = 0;
      const remove = () => {
        clearTimeout(timer);
        toast.remove();
      };
      close.addEventListener('click', remove);
      toast.append(text, close);
      // Added on the next turn, so the region is already there and the addition is announced.
      setTimeout(() => {
        live.append(toast);
        while (live.children.length > 3) live.firstElementChild.remove();
        if (!reducedMotion()) confetti(toast);
        timer = setTimeout(() => {
          // Left up while the learner is reading it with the keyboard or the pointer.
          if (toast.matches(':hover, :focus-within')) timer = setTimeout(remove, ms);
          else remove();
        }, ms);
      }, 30);
      return toast;
    },
  };
}

/**
 * The awards a lab just earned, shown on its result card: a short list under the stats. The card is a live
 * region, so each one is said as it appears. `host` is #resultAwards.
 */
export function createResultAwards(host) {
  const earned = [];
  const draw = () => {
    host.replaceChildren();
    if (!earned.length) {
      host.hidden = true;
      return;
    }
    host.append(el('p', 'result-awards-label', earned.length === 1 ? 'New award' : 'New awards'));
    const list = el('ul', 'result-awards-list');
    for (const a of earned) list.append(miniAward(a));
    host.append(list);
    host.hidden = false;
  };
  return {
    add(award) {
      if (!award?.title || earned.some((a) => a.id === award.id)) return;
      earned.push(award);
      draw();
    },
    clear() {
      earned.length = 0;
      draw();
    },
    count: () => earned.length,
  };
}
