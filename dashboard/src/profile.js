/**
 * The learner's skills, level and awards: the profile page, and the "Your progress" band on Home.
 *
 * What is drawn is the service's own answer (GET /api/profile): the scores, the level names and the plain
 * evaluation sentences are never worked out here. This file only lays them out, in words and numbers as
 * well as shape: a ring or a bar is always beside its number and its level name, and every meter says what
 * it measures to a screen reader. Text from the service goes in through textContent.
 */
import { icon, svgIcon } from './icons.js';
import { platformAreas } from './learn-model.js';
import { awardsShelf, miniAward } from './awards.js';
import pathMeta from '../../packages/catalogue/paths.json';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The names a score can have, weakest first. */
export const LEVEL_NAMES = ['Not started', 'Foundations', 'Practitioner', 'Proficient', 'Expert'];

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clampScore = (v) => Math.max(0, Math.min(100, Math.round(num(v))));
const list = (v) => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------------ what the page reads

/**
 * The quiz result this browser holds, as `?starting=` takes it: "gateway:ok,mcp:new". Only the three levels the
 * console knows, only plain area names. The levels live in localStorage; they are a starting point, never a score.
 */
export function startingParam(levels) {
  if (!levels || typeof levels !== 'object') return '';
  return Object.entries(levels)
    .filter(([area, level]) => /^[a-z]{2,24}$/.test(area) && ['new', 'ok', 'strong'].includes(level))
    .map(([area, level]) => `${area}:${level}`)
    .join(',');
}

/** The words for an onboarding level on a skill ("Quiz starting point: Familiar"). */
export const STARTING_WORDS = { new: 'New to it', ok: 'Familiar', strong: 'Strong' };

/** The icon and accent family of the module an area belongs to (a slate grid when the copy has none). */
export function areaLook(area) {
  const entry = platformAreas().find((a) => a.area === area);
  const module = entry ? pathMeta.paths?.find((p) => p.slug === entry.path)?.modules?.find((m) => m.number === entry.module) : null;
  return { icon: module?.icon || 'grid', accent: module?.accent || 'slate' };
}

/** A brand-new learner: no XP, no score anywhere, no award. Home asks them to finish a lab instead of showing zeroes. */
export function isNewLearner(compact) {
  return num(compact?.xp) === 0 && num(compact?.overall?.score) === 0 && list(compact?.recent_awards).length === 0;
}

/** "25 of 250 XP to level 4", or "Top level reached" at the last level. */
export function xpLine(level) {
  const needed = num(level?.xp_needed);
  if (needed <= 0) return 'Top level reached';
  return `${num(level?.xp_into)} of ${needed} XP to level ${num(level?.n, 1) + 1}`;
}

/** "3-day streak", "No streak yet". */
export function streakText(streak) {
  const days = num(streak?.days);
  return days > 0 ? `${days}-day streak` : 'No streak yet';
}

// ------------------------------------------------------------------ small parts

/** A bar for a number out of a total that says what it is: role=meter, with its numbers in words. */
export function meterBar({ label, now, max, text, className = 'meter' }) {
  const bar = el('div', className);
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(max));
  bar.setAttribute('aria-valuenow', String(now));
  if (text) bar.setAttribute('aria-valuetext', text);
  const fill = document.createElement('i');
  fill.style.width = `${max > 0 ? Math.round((Math.min(now, max) / max) * 100) : 0}%`;
  bar.append(fill);
  return bar;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

/** A score ring, 0-100, with the number in the middle. The wrapper is the meter; the picture is decoration. */
export function scoreRing({ label, score, level, size = 'md' }) {
  const value = clampScore(score);
  const wrap = el('span', `score-ring score-ring-${size}`);
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-label', label);
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  wrap.setAttribute('aria-valuenow', String(value));
  wrap.setAttribute('aria-valuetext', `${value} out of 100${level ? `, ${level}` : ''}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ring-track');
  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('class', 'ring-fill');
  for (const c of [track, fill]) {
    c.setAttribute('cx', '32');
    c.setAttribute('cy', '32');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('fill', 'none');
  }
  fill.setAttribute('stroke-dasharray', `${((RING_C * value) / 100).toFixed(2)} ${RING_C.toFixed(2)}`);
  fill.setAttribute('stroke-linecap', 'round');
  svg.append(track, fill);
  const number = el('span', 'ring-number', String(value));
  number.setAttribute('aria-hidden', 'true');
  wrap.append(svg, number);
  return wrap;
}

/** The flame glyph of a streak. */
const flame = (size = 18) =>
  svgIcon('<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.2 1 2 2 2 0-3-.5-5 1-8z"/>', size);

/** A level name as a chip: the word always, so the colour never has to be read. */
const levelChip = (name) => {
  const chip = el('span', 'level-name', name);
  chip.dataset.level = name;
  return chip;
};

// ------------------------------------------------------------------ the profile page

function skillCard(skill, startingLevels) {
  const area = String(skill.area ?? '');
  const look = areaLook(area);
  const title = String(skill.title ?? area);
  const levelName = LEVEL_NAMES.includes(skill.level) ? skill.level : 'Not started';
  const card = el('article', 'skill-card');
  card.dataset.area = area;
  card.dataset.accent = look.accent;
  card.dataset.level = levelName;
  const id = `skill-${area}`;
  card.setAttribute('aria-labelledby', `${id}-title`);

  const top = el('div', 'skill-top');
  const tile = el('span', 'tile skill-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(look.icon, 22));
  const heading = el('h3', 'skill-title', title);
  heading.id = `${id}-title`;
  top.append(tile, heading);

  const score = el('div', 'skill-score');
  score.append(scoreRing({ label: `${title} score`, score: skill.score, level: levelName }));
  const words = el('div', 'skill-score-words');
  words.append(levelChip(levelName), el('span', 'skill-score-note', levelName === 'Not started' ? 'Score 0 out of 100' : `Score ${clampScore(skill.score)} out of 100`));
  score.append(words);

  card.append(top, score);
  if (skill.evaluation) card.append(el('p', 'skill-eval', String(skill.evaluation)));

  const done = Math.max(0, num(skill.labs_done));
  const total = Math.max(0, num(skill.labs_total));
  const labs = el('div', 'skill-labs');
  labs.append(el('p', 'skill-labs-line', total ? `${done} of ${total} labs done` : 'No labs here yet'));
  if (total) labs.append(meterBar({ label: `Labs done in ${title}`, now: done, max: total, text: `${done} of ${total} labs`, className: 'meter meter-thin' }));
  card.append(labs);

  const hint = skill.starting_level ?? startingLevels?.[area];
  if (STARTING_WORDS[hint]) card.append(el('p', 'skill-quiz', `Quiz starting point: ${STARTING_WORDS[hint]}`));

  const next = skill.next_lab;
  if (next && typeof next.slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}$/.test(next.slug)) {
    const link = el('a', 'btn btn-strong skill-next');
    link.href = `/labs/${encodeURIComponent(next.slug)}`;
    link.textContent = 'Next lab';
    // The name a screen reader says starts with the words on the button, then says which lab it is.
    link.setAttribute('aria-label', `Next lab: ${next.title ?? next.slug}`);
    card.append(link);
  } else if (total && done >= total) {
    card.append(el('p', 'skill-all-done', 'Every lab in this area is done.'));
  }
  return card;
}

/** The whole profile as a page body. `data` is GET /api/profile. */
export function profileContent(data, { startingLevels } = {}) {
  const root = document.createDocumentFragment();
  const level = data.level ?? {};
  const levelNum = num(level.n, 1);
  const overall = data.overall ?? {};
  const overallLevel = LEVEL_NAMES.includes(overall.level) ? overall.level : 'Not started';

  // The head: level, XP and streak on one side, the overall score on the other.
  const head = el('section', 'profile-head');
  head.setAttribute('aria-labelledby', 'profileLevelHeading');
  const levelBox = el('div', 'profile-level');
  const levelHeading = el('h2', 'profile-level-name');
  levelHeading.id = 'profileLevelHeading';
  levelHeading.append(el('span', 'profile-level-num', `Level ${levelNum}`), document.createTextNode(' '), el('span', 'profile-level-title', String(level.title ?? '')));
  levelBox.append(levelHeading);
  const needed = num(level.xp_needed);
  levelBox.append(
    meterBar({
      label: needed > 0 ? `XP towards level ${levelNum + 1}` : 'XP',
      now: needed > 0 ? num(level.xp_into) : 1,
      max: needed > 0 ? needed : 1,
      text: xpLine(level),
      className: 'meter xp-bar',
    })
  );
  const xp = el('p', 'xp-line');
  xp.append(el('b', '', `${num(data.xp)} XP`), document.createTextNode(` · ${xpLine(level)}`));
  levelBox.append(xp);
  const streak = el('p', 'streak');
  streak.dataset.days = String(num(data.streak?.days));
  const streakIcon = el('span', 'streak-flame');
  streakIcon.setAttribute('aria-hidden', 'true');
  streakIcon.append(flame(18));
  streak.append(streakIcon, el('b', '', streakText(data.streak)));
  const best = num(data.streak?.best);
  if (best > 0) streak.append(el('span', 'streak-best', ` · Best: ${best} ${best === 1 ? 'day' : 'days'}`));
  levelBox.append(streak);

  const overallBox = el('div', 'profile-overall');
  const overallHeading = el('h2', 'profile-overall-title', 'Overall score');
  overallHeading.id = 'profileOverallHeading';
  const overallRow = el('div', 'profile-overall-row');
  overallRow.append(scoreRing({ label: 'Overall score', score: overall.score, level: overallLevel, size: 'lg' }));
  const overallWords = el('div', 'profile-overall-words');
  overallWords.append(levelChip(overallLevel), el('span', 'skill-score-note', `Score ${clampScore(overall.score)} out of 100`));
  overallRow.append(overallWords);
  overallBox.append(overallHeading, overallRow);
  if (overall.evaluation) overallBox.append(el('p', 'overall-eval', String(overall.evaluation)));
  head.append(levelBox, overallBox);
  root.append(head);

  // Skills.
  const skills = el('section', 'profile-section');
  skills.setAttribute('aria-labelledby', 'profileSkillsHeading');
  const skillsHeading = el('h2', 'profile-section-title', 'Your skills');
  skillsHeading.id = 'profileSkillsHeading';
  skills.append(skillsHeading, el('p', 'profile-section-lede', 'A score for each area, from the labs you have finished and how they went. Hints and extra tries lower it a little.'));
  const grid = el('div', 'skill-grid');
  for (const skill of list(data.skills)) grid.append(skillCard(skill, startingLevels));
  skills.append(grid);
  root.append(skills);

  // Awards.
  const awards = el('section', 'profile-section');
  awards.setAttribute('aria-labelledby', 'profileAwardsHeading');
  const awardsHeading = el('h2', 'profile-section-title', 'Awards');
  awardsHeading.id = 'profileAwardsHeading';
  awards.append(awardsHeading, awardsShelf(data.awards));
  root.append(awards);
  return root;
}

/**
 * The profile page: a heading, then what the store holds. Drawn from the store's state at once and again on
 * every change, so coming back to it never flashes. `retry` asks the store to load again.
 */
export function profilePage({ state, startingLevels, errorText = '', retry }) {
  const root = el('div', 'profile-page-body');
  if (state.data) {
    root.append(profileContent(state.data, { startingLevels }));
  } else if (state.status === 'error') {
    const note = el('div', 'notice notice-bad');
    note.setAttribute('role', 'alert');
    note.append(el('p', 'profile-error', `Could not load your profile. ${errorText}`.trim()));
    const again = el('button', 'btn', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => retry?.());
    note.append(again);
    root.append(note);
  } else {
    root.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 3; i++) {
      const bone = el('div', 'profile-skeleton');
      bone.setAttribute('aria-hidden', 'true');
      root.append(bone);
    }
    root.append(el('p', 'sr-only', 'Loading your profile…'));
  }
  return root;
}

// ------------------------------------------------------------------ Home: "Your progress"

/**
 * The compact band on Home: overall score and level, XP bar, streak, the top three skills as small bars, the
 * last three awards as small badges, and a link to the profile. A brand-new learner gets one line asking them
 * to finish a lab. `data` is GET /api/profile?compact=1.
 */
export function progressBand(data) {
  const band = el('section', 'progress-band');
  band.id = 'homeProgress';
  band.setAttribute('aria-labelledby', 'homeProgressHeading');
  const head = el('div', 'band-head');
  const heading = el('h2', 'band-title', 'Your progress');
  heading.id = 'homeProgressHeading';
  const link = el('a', 'btn btn-ghost band-link', 'View profile');
  link.href = '/profile';
  head.append(heading, link);
  band.append(head);

  if (isNewLearner(data)) {
    band.dataset.empty = '1';
    band.append(el('p', 'band-empty', 'Finish a lab to start your score.'));
    return band;
  }

  const level = data.level ?? {};
  const overall = data.overall ?? {};
  const overallLevel = LEVEL_NAMES.includes(overall.level) ? overall.level : 'Not started';
  const body = el('div', 'band-body');

  const score = el('div', 'band-score');
  score.append(scoreRing({ label: 'Overall score', score: overall.score, level: overallLevel }));
  const words = el('div', 'band-score-words');
  words.append(el('span', 'band-label', 'Overall'), levelChip(overallLevel));
  score.append(words);

  const xp = el('div', 'band-xp');
  const needed = num(level.xp_needed);
  const levelNum = num(level.n, 1);
  xp.append(el('p', 'band-level', `Level ${levelNum} · ${level.title ?? ''}`.trim()));
  xp.append(
    meterBar({ label: needed > 0 ? `XP towards level ${levelNum + 1}` : 'XP', now: needed > 0 ? num(level.xp_into) : 1, max: needed > 0 ? needed : 1, text: xpLine(level), className: 'meter xp-bar meter-thin' })
  );
  xp.append(el('p', 'band-xp-line', xpLine(level)));
  const streak = el('p', 'streak band-streak');
  streak.dataset.days = String(num(data.streak?.days));
  const streakIcon = el('span', 'streak-flame');
  streakIcon.setAttribute('aria-hidden', 'true');
  streakIcon.append(flame(16));
  streak.append(streakIcon, el('b', '', streakText(data.streak)));
  xp.append(streak);

  const skills = el('div', 'band-skills');
  const skillsLabel = el('h3', 'band-sub', 'Top skills');
  skillsLabel.id = 'homeSkillsHeading';
  skills.append(skillsLabel);
  const skillList = el('ul', 'band-skill-list');
  skillList.setAttribute('aria-labelledby', 'homeSkillsHeading');
  for (const s of list(data.top_skills).slice(0, 3)) {
    const li = el('li', 'band-skill');
    li.dataset.accent = areaLook(s.area).accent;
    const title = String(s.title ?? s.area);
    li.append(el('span', 'band-skill-name', title));
    li.append(meterBar({ label: `${title} score`, now: clampScore(s.score), max: 100, text: `${clampScore(s.score)} out of 100, ${s.level ?? ''}`.replace(/, $/, ''), className: 'meter meter-thin' }));
    li.append(el('span', 'band-skill-score', `${clampScore(s.score)}`));
    skillList.append(li);
  }
  skills.append(skillList);

  const awards = el('div', 'band-awards');
  const awardsLabel = el('h3', 'band-sub', 'Latest awards');
  awardsLabel.id = 'homeAwardsHeading';
  awards.append(awardsLabel);
  const recent = list(data.recent_awards).slice(0, 3);
  if (recent.length) {
    const ul = el('ul', 'band-award-list');
    ul.setAttribute('aria-labelledby', 'homeAwardsHeading');
    for (const a of recent) ul.append(miniAward(a));
    awards.append(ul);
  } else {
    awards.append(el('p', 'band-awards-empty', 'No awards yet.'));
  }

  body.append(score, xp, skills, awards);
  band.append(body);
  return band;
}
