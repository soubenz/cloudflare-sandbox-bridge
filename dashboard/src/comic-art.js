/**
 * The motion comic's art, drawn from code: the cast as simple geometric busts,
 * a handful of props, and one SVG scene per template (desk, message, portrait,
 * screen, duo, you, and the two cards: black and diagram). Nothing here is an
 * image and nothing here knows about time; comic.js lays the art in a panel
 * and the timeline decides when what shows. The look is the design's
 * StoryComic: thick navy outlines, flat fills, a few ambient loops (bob,
 * blink, twinkle, a key press, a glowing phone, film grain) that comic.css
 * switches off for reduced motion, for a finished comic and for the test clock.
 *
 * A person in a panel's cast is an id ('maren') or { who, mood, pose }: a mood
 * changes the brows, eyes and mouth (tired, worried, pleased, surprised), a
 * pose adds what the hands do (phone, typing, shrug). A panel on the `night`
 * background gets a moon, a lamp's cone and the glow of a screen.
 *
 * The strings built here contain no text from a lab: words, captions and
 * screen lines are drawn as HTML over the art (comic.js, with textContent), so
 * assigning these strings to innerHTML never puts content someone wrote into
 * markup. The diagram card is the one scene with words in its picture: they
 * come from the diagram library through diagram.js, which builds every node
 * with createElement and textContent (applyDiagramStep, below). Colours that
 * belong to the interface are variables (--cm-*, from comic.css, light and
 * dark); the people's own colours, the moon and the lamp are drawn here.
 */

import * as kitDefs from '../../src/labs/comic-kit.ts';
import library from '../../packages/catalogue/diagrams.json';
import { SCREENS } from './comic-timeline.js';
import { renderDiagram } from './diagram.js';

const { SCENES } = kitDefs;
const INK = 'var(--cm-ink)';
const SCREEN_BG = 'var(--cm-screen-bg)';
const SCREEN_TEXT = 'var(--cm-screen-text)';
const BLACK = 'var(--cm-black)';
const BLACK_RULE = 'var(--cm-black-rule)';
const DGM_PLATE = 'var(--cm-dgm-plate)';
/** Light drawn into the art (not the interface's): the moon, a lamp's warm cone, a blush. */
const MOON = '#f4ecd0';
const LAMP = '#ffd27a';
const BLUSH = '#ff8fa3';

/** Panel art sizes in art units: the height is fixed, a wide panel is twice the width of a square one plus a gutter. */
export const ART = { h: 320, wide: 697, square: 337 };
/** The span of a card scene comic-kit does not (yet) list, so the art can be drawn either way. */
const CARD_SPAN = { black: 2, diagram: 2 };
export const artWidth = (scene) => ((SCENES[scene]?.span ?? CARD_SPAN[scene] ?? 1) === 2 ? ART.wide : ART.square);

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

/** The moods and poses the art draws: comic-kit's lists (the schema's), these until it has them. */
export const MOODS = kitDefs.MOODS ?? ['tired', 'worried', 'pleased', 'surprised'];
export const POSES = kitDefs.POSES ?? ['phone', 'typing', 'shrug'];

const line = (w = 4) => `stroke="${INK}" stroke-width="${w}"`;
const body = (shirt) => `<path d="M8 130c2-30 22-42 52-42s50 12 52 42z" fill="${shirt}" ${line()} stroke-linejoin="round"/>`;
/** Shoulders up: the same shirt with its shoulders lifted to the ears. */
const shrugBody = (shirt) => `<path d="M8 130c0-20 4-34 14-43 10 5 24 4 38 4s28 1 38-4c10 9 14 23 14 43z" fill="${shirt}" ${line()} stroke-linejoin="round"/>`;
const neck = (skin) => `<rect x="50" y="70" width="20" height="22" rx="8" fill="${skin}" ${line()}/>`;
const head = (skin) => `<path d="M26 52c0-26 14-38 34-38s34 12 34 38c0 20-14 36-34 36S26 72 26 52z" fill="${skin}" ${line()}/>`;
const eyes = (y = 57, r = 4.5, l = 48, rr = 74) => `<circle class="cm-eye" cx="${l}" cy="${y}" r="${r}" fill="${INK}"/><circle class="cm-eye" cx="${rr}" cy="${y}" r="${r}" fill="${INK}"/>`;
const smile = (d = 'M50 74c6 6 16 6 22 0') => `<path class="cm-mouth" d="${d}" fill="none" ${line()} stroke-linecap="round"/>`;
const collar = '<path d="M48 88l12 14 12-14" fill="#fff" ' + line() + ' stroke-linejoin="round"/>';
const n1 = (v) => Math.round(v * 10) / 10;

/**
 * Brows and eyes for a mood, on eyes centred at (l, y) and (rr, y) of radius r.
 * Every eye keeps the class the blink animates.
 */
function moodEyes(mood, y, r, l, rr, bw) {
  const by = y - 12.5;
  const brow = (d) => `<path class="cm-brow" d="${d}" fill="none" ${line(bw)} stroke-linecap="round"/>`;
  const dot = (cx, rad = r) => `<circle class="cm-eye" cx="${cx}" cy="${y}" r="${n1(rad)}" fill="${INK}"/>`;
  switch (mood) {
    case 'tired': {
      // heavy lids: the top half of the eye is a lid, a line across it, a bag beneath; flat low brows
      const eye = (cx) =>
        `<path class="cm-eye" d="M${n1(cx - r - 0.5)} ${y}a${n1(r + 0.5)} ${n1(r + 0.5)} 0 0 0 ${n1(2 * r + 1)} 0z" fill="${INK}"/>` +
        `<path d="M${n1(cx - r - 2.5)} ${y - 0.5}h${n1(2 * r + 5)}" ${line(3)} stroke-linecap="round"/>` +
        `<path d="M${cx - 4} ${n1(y + r + 4)}q4 2.5 8 0" fill="none" ${line(2)} stroke-linecap="round" opacity=".55"/>`;
      return eye(l) + eye(rr) + brow(`M${l - 6} ${by + 3}h12M${rr - 6} ${by + 3}h12`);
    }
    case 'worried':
      // the inner ends of the brows lifted
      return dot(l, r * 0.9) + dot(rr, r * 0.9) + brow(`M${l - 6} ${by + 1}L${l + 5} ${by - 4}M${rr + 6} ${by + 1}L${rr - 5} ${by - 4}`);
    case 'pleased': {
      // relaxed arched brows, cheeks lifted under the eyes, a blush
      const cheek = (cx) =>
        `<path d="M${cx - 5} ${n1(y + r + 4)}q5-3.5 10 0" fill="none" ${line(2.5)} stroke-linecap="round"/>` +
        `<ellipse cx="${cx}" cy="${n1(y + r + 10)}" rx="5.5" ry="3" fill="${BLUSH}" fill-opacity=".5"/>`;
      // (a little outward of the eyes, so the cheeks are not read as part of the grin)
      return dot(l) + dot(rr) + cheek(l - 3) + cheek(rr + 3) + brow(`M${l - 6} ${by + 1}q6-5 12 0M${rr - 6} ${by + 1}q6-5 12 0`);
    }
    case 'surprised': {
      // wide eyes: a white eye with a small pupil; brows high and round
      const eye = (cx) =>
        `<g class="cm-eye"><circle cx="${cx}" cy="${y}" r="${n1(r + 3.2)}" fill="#fff" ${line(2.5)}/><circle cx="${cx}" cy="${y}" r="${n1(r * 0.75)}" fill="${INK}"/></g>`;
      return eye(l) + eye(rr) + brow(`M${l - 6} ${by - 3}q6-6 12 0M${rr - 6} ${by - 3}q6-6 12 0`);
    }
    default:
      return eyes(y, r, l, rr);
  }
}

/** A mouth for a mood, centred on the face's own mouth at (cx, cy). It keeps the class the talking animates. */
function moodMouth(mood, cx, cy) {
  switch (mood) {
    case 'tired':
      return `<rect class="cm-mouth" x="${cx - 7}" y="${cy - 1.5}" width="14" height="3.5" rx="1.75" fill="${INK}"/>`;
    case 'worried':
      return `<ellipse class="cm-mouth" cx="${cx}" cy="${cy + 1}" rx="3.6" ry="4.4" fill="${INK}"/>`;
    case 'pleased':
      return `<path class="cm-mouth" d="M${cx - 12} ${cy - 3}q12 15 24 0z" fill="${INK}" ${line(3)} stroke-linejoin="round"/>`;
    case 'surprised':
      return `<ellipse class="cm-mouth" cx="${cx}" cy="${cy + 2}" rx="5.5" ry="7.5" fill="${INK}"/>`;
    default:
      return '';
  }
}

/** What a bust draws with: the plain pieces, or a mood's and a pose's in their place. */
function kit(mood, pose) {
  return {
    body: (shirt) => (pose === 'shrug' ? shrugBody(shirt) : body(shirt)),
    eyes: (y = 57, r = 4.5, l = 48, rr = 74, bw = 3.5) => (mood ? moodEyes(mood, y, r, l, rr, bw) : eyes(y, r, l, rr)),
    brows: (d) => (mood ? '' : d),
    mouth: (d, cx, cy) => (mood ? moodMouth(mood, cx, cy) : d),
  };
}

const SKIN = { maren: '#f1c7a1', tomasz: '#e8b98f', jonas: '#f3d2b3', priya: '#c98f66', anneke: '#f6d9c0', you: '#4a5896' };
const SHIRT = { maren: '#3552f2', tomasz: '#0e8577', jonas: '#f0a04b', priya: '#d02650', anneke: '#7c3aed', you: '#9aabff' };

/**
 * Each bust is drawn on a 120 by 130 board. What tells them apart at a glance:
 *   maren   dark swept fringe, cobalt jacket with a white collar        (platform lead)
 *   tomasz  short brown hair, round glasses, teal                        (staff engineer)
 *   jonas   grey hair, heavy brows, amber                                (finance)
 *   priya   long dark hair, a support headset with a microphone, rose    (head of support)
 *   anneke  blond bob, square glasses, violet, a lanyard with a badge    (data protection)
 *   you     a plain dark silhouette: the learner
 * `k` is kit(): with no mood and no pose every bust draws exactly as it always has.
 */
const BUSTS = {
  maren: (k) =>
    k.body(SHIRT.maren) + collar + neck(SKIN.maren) + head(SKIN.maren) +
    `<path d="M22 58c-6-34 14-50 40-50 26 0 42 18 36 50-4-14-10-22-18-26-14 6-34 8-50-4-4 6-6 18-8 30z" fill="#1c2446" ${line()} stroke-linejoin="round"/>` +
    k.eyes(56) + k.mouth(smile(), 61, 76),
  tomasz: (k) =>
    k.body(SHIRT.tomasz) + neck(SKIN.tomasz) + head(SKIN.tomasz) +
    `<path d="M26 46c0-24 14-36 34-36s34 12 34 36c-8-10-16-14-34-14s-26 4-34 14z" fill="#5a3a22" ${line()} stroke-linejoin="round"/>` +
    `<circle cx="46" cy="58" r="10" fill="#fff" fill-opacity=".55" ${line(3.5)}/><circle cx="76" cy="58" r="10" fill="#fff" fill-opacity=".55" ${line(3.5)}/><path d="M56 58h10" ${line(3.5)}/>` +
    k.eyes(58, 3.5, 46, 76) + k.mouth(smile('M52 77c6 4 14 4 20-2'), 62, 78),
  jonas: (k) =>
    k.body(SHIRT.jonas) + collar + neck(SKIN.jonas) + head(SKIN.jonas) +
    `<path d="M28 44c2-20 14-32 32-32s30 12 32 32c-6-8-12-12-32-12s-26 4-32 12z" fill="#9aa3c7" ${line()} stroke-linejoin="round"/>` +
    k.eyes(58, 4.5, 48, 74, 5) + k.brows(`<path d="M42 48l12-4M80 48l-12-4" ${line()} stroke-linecap="round"/>`) +
    k.mouth(`<ellipse class="cm-mouth" cx="61" cy="77" rx="8" ry="5" fill="${INK}"/>`, 61, 77),
  priya: (k) =>
    `<path d="M14 126c-8-44-2-100 46-104 48 4 54 60 46 104z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    k.body(SHIRT.priya) +
    `<path d="M24 88c-6 14-8 28-6 40h16c0-14 2-28 6-38z" fill="#241611" ${line()} stroke-linejoin="round"/><path d="M96 88c6 14 8 28 6 40H86c0-14-2-28-6-38z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    neck(SKIN.priya) + head(SKIN.priya) +
    `<path d="M26 50c0-24 14-38 34-38s34 14 34 38c-12-4-22-14-28-24-4 12-22 24-40 24z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    `<path d="M22 58C16 22 40 6 60 6s46 16 38 52" fill="none" stroke="#26305a" stroke-width="5" stroke-linecap="round"/>` +
    `<rect x="14" y="50" width="12" height="24" rx="6" fill="#26305a" ${line(3)}/><rect x="94" y="50" width="12" height="24" rx="6" fill="#26305a" ${line(3)}/>` +
    `<path d="M20 72c0 14 10 22 26 20" fill="none" stroke="#26305a" stroke-width="4" stroke-linecap="round"/><circle cx="48" cy="92" r="5" fill="#26305a" ${line(2.5)}/>` +
    k.eyes(58) + k.mouth(smile(), 61, 76),
  anneke: (k) =>
    `<path d="M18 98c-6-50 6-88 42-88s48 38 42 88c-8 2-16-2-20-10H38c-4 8-12 12-20 10z" fill="#e6bf62" ${line()} stroke-linejoin="round"/>` +
    k.body(SHIRT.anneke) +
    `<path d="M46 90l14 30 14-30" fill="none" stroke="#3552f2" stroke-width="4" stroke-linejoin="round"/><rect x="51" y="112" width="18" height="14" rx="3" fill="#fff" ${line(3)}/><path d="M55 118h10" ${line(2.5)}/>` +
    neck(SKIN.anneke) + head(SKIN.anneke) +
    `<path d="M26 48c4-22 16-34 34-34s30 12 34 34c-10-6-20-12-26-20-8 10-24 18-42 20z" fill="#e6bf62" ${line()} stroke-linejoin="round"/>` +
    `<rect x="33" y="50" width="24" height="17" rx="4" fill="#fff" fill-opacity=".5" ${line(3.5)}/><rect x="63" y="50" width="24" height="17" rx="4" fill="#fff" fill-opacity=".5" ${line(3.5)}/><path d="M57 57h6" ${line(3.5)}/>` +
    k.eyes(59, 3.5, 45, 75) + k.mouth(smile('M52 77c6 4 14 4 20 0'), 62, 79),
  // The learner has no face, so a mood changes nothing drawn; a pose does.
  you: (k) =>
    k.body(SHIRT.you) +
    `<rect x="50" y="70" width="20" height="22" rx="8" fill="${SKIN.you}" ${line()}/>` +
    `<path d="M26 52c0-26 14-38 34-38s34 12 34 38c0 26-14 40-34 40S26 78 26 52z" fill="${SKIN.you}" ${line()}/>` +
    `<path d="M40 40c6-10 18-14 30-12" fill="none" stroke="#9aabff" stroke-width="4" stroke-linecap="round"/>`,
};

/** What the hands do, drawn over the bust on its own board. */
function poseArt(pose, skin, shirt) {
  const sleeve = (d) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="15" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${shirt}" stroke-width="8" stroke-linecap="round"/>`;
  switch (pose) {
    case 'phone':
      // held up beside the chin, its screen the brightest thing in the panel
      return (
        `<g class="cm-hold">` +
        `<rect class="cm-glow" x="62" y="58" width="50" height="66" rx="20" fill="${SCREEN_TEXT}" opacity=".3"/>` +
        sleeve('M70 131L84 112') +
        `<g transform="rotate(-10 87 91)"><rect x="75" y="70" width="24" height="42" rx="5" fill="#26305a" ${line(3.5)}/>` +
        `<rect x="78.5" y="75" width="17" height="30" rx="2" fill="${SCREEN_TEXT}"/>` +
        `<path d="M81.5 81h11M81.5 87h8M81.5 93h10" stroke="${SCREEN_BG}" stroke-width="2" stroke-linecap="round"/></g>` +
        `<ellipse cx="86" cy="110" rx="9" ry="7" fill="${skin}" ${line(3)}/><path d="M77 101c-3 2-4 6-2 9" fill="none" stroke="${skin}" stroke-width="5" stroke-linecap="round"/>` +
        `</g>`
      );
    case 'typing':
      // a keyboard in front, the two hands pressing keys in turn
      return (
        `<path d="M8 113l9-13h86l9 13z" fill="#b3b9d1" ${line(3.5)} stroke-linejoin="round"/>` +
        `<path d="M22 105h76M18 109h84" stroke="${INK}" stroke-width="1.6" stroke-dasharray="5 3" opacity=".5"/>` +
        `<g class="cm-key"><ellipse cx="38" cy="103" rx="11" ry="6.5" fill="${skin}" ${line(3)}/></g>` +
        `<g class="cm-key cm-key-b"><ellipse cx="82" cy="103" rx="11" ry="6.5" fill="${skin}" ${line(3)}/></g>`
      );
    case 'shrug': {
      // forearms out and up, open palms
      const palm = (x, dir) =>
        `<circle cx="${x}" cy="82" r="7" fill="${skin}" ${line(3)}/>` +
        `<path d="M${x - 4 * dir} 76l${-2 * dir}-5M${x} 74.5v-6M${x + 4 * dir} 76l${2 * dir}-5" fill="none" stroke="${skin}" stroke-width="3.5" stroke-linecap="round"/>`;
      return sleeve('M24 101C12 104 4 98 -2 88') + sleeve('M96 101C108 104 116 98 122 88') + palm(-5, 1) + palm(125, -1);
    }
    default:
      return '';
  }
}

/** A cast entry as { who, mood?, pose? }: a string is just who; anything unreadable is null. */
export function castEntry(c) {
  if (typeof c === 'string') return { who: c };
  if (!c || typeof c !== 'object' || typeof c.who !== 'string') return null;
  const out = { who: c.who };
  if (MOODS.includes(c.mood)) out.mood = c.mood;
  if (POSES.includes(c.pose)) out.pose = c.pose;
  return out;
}

/** The i-th person of a panel, the learner when there is none. */
const member = (p, i) => castEntry(Array.isArray(p?.cast) ? p.cast[i] : undefined) ?? { who: 'you' };
/** An id safe in an attribute (one comes from a lab's file); anything else is the learner. */
const safeId = (id) => (typeof id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(id) ? id : 'you');

/**
 * A bust at (x, y), `w` wide (the board is 120 by 130). `id` is a cast entry: an id,
 * or { who, mood, pose }; `look` ({ mood, pose }) overrides what the entry says.
 * `data-cast` lets the player find who is talking.
 */
export function bust(id, x, y, w, extra = '', look) {
  const m = castEntry(id) ?? { who: 'you' };
  const who = safeId(m.who);
  const mood = MOODS.includes(look?.mood) ? look.mood : m.mood;
  const pose = POSES.includes(look?.pose) ? look.pose : m.pose;
  const draw = BUSTS[who] ?? BUSTS.you;
  const kin = BUSTS[who] ? who : 'you';
  const h = (w * 130) / 120;
  const cls = `cm-char${mood ? ` cm-mood-${mood}` : ''}${pose ? ` cm-pose-${pose}` : ''} ${extra}`;
  const art = draw(kit(mood, pose)) + (pose ? poseArt(pose, SKIN[kin], SHIRT[kin]) : '');
  return `<g class="${cls}" data-cast="${who}"><svg x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" viewBox="0 0 120 130" overflow="visible">${art}</svg></g>`;
}

// ---------------------------------------------------------------------------
// Props: each drawn in a box about 80 wide
// ---------------------------------------------------------------------------

const PROP_ART = {
  envelope: () =>
    `<rect x="0" y="12" width="80" height="54" rx="6" fill="#fff" ${line()}/><path d="M2 16l38 28 38-28" fill="none" ${line()} stroke-linejoin="round"/>` +
    `<rect x="12" y="0" width="38" height="16" rx="5" fill="#3552f2" ${line(3)}/>`,
  laptop: () =>
    `<rect x="8" y="4" width="64" height="44" rx="5" fill="#26305a" ${line()}/><rect x="14" y="10" width="52" height="32" rx="2" fill="${SCREEN_BG}"/>` +
    `<path d="M20 20h22M20 28h30M20 35h14" stroke="${SCREEN_TEXT}" stroke-width="3" stroke-linecap="round"/><path d="M0 52h80l-6 11H6z" fill="#b3b9d1" ${line()} stroke-linejoin="round"/>`,
  chart: () =>
    `<rect x="0" y="0" width="80" height="64" rx="8" fill="#fff" ${line()}/><rect x="12" y="34" width="12" height="20" fill="#3552f2" ${line(2.5)}/><rect x="34" y="20" width="12" height="34" fill="#0e8577" ${line(2.5)}/><rect x="56" y="10" width="12" height="44" fill="#f0a04b" ${line(2.5)}/><path d="M8 56h64" ${line(3)}/>`,
  map: () =>
    `<path d="M2 12l24-8 28 8 24-8v52l-24 8-28-8-24 8z" fill="#dcf4f0" ${line()} stroke-linejoin="round"/><path d="M26 4v52M54 12v52" fill="none" ${line(2.5)}/>` +
    `<path d="M44 14c-8 0-12 6-12 12 0 8 12 18 12 18s12-10 12-18c0-6-4-12-12-12z" fill="#d02650" ${line(3)}/><circle cx="44" cy="26" r="4" fill="#fff"/>`,
  key: () =>
    `<circle cx="22" cy="30" r="16" fill="none" stroke="${INK}" stroke-width="13"/><circle cx="22" cy="30" r="16" fill="none" stroke="#f0a548" stroke-width="7"/>` +
    `<rect x="36" y="26" width="42" height="9" rx="3" fill="#f0a548" ${line(3)}/><rect x="60" y="34" width="7" height="12" fill="#f0a548" ${line(3)}/><rect x="71" y="34" width="7" height="9" fill="#f0a548" ${line(3)}/>`,
  document: () =>
    `<path d="M8 0h42l22 22v58H8z" fill="#fff" ${line()} stroke-linejoin="round"/><path d="M50 0v22h22" fill="#e6ebff" ${line(3)} stroke-linejoin="round"/>` +
    `<path d="M20 38h40M20 50h40M20 62h24" stroke="#3552f2" stroke-width="4" stroke-linecap="round"/>`,
};

/** A prop at (x, y), scaled; `cls` is for the animation of the inner group. */
function prop(name, x, y, scale = 1, cls = '') {
  const draw = Object.hasOwn(PROP_ART, name) ? PROP_ART[name] : null;
  return draw ? `<g transform="translate(${x} ${y}) scale(${scale})"><g class="${cls}">${draw()}</g></g>` : '';
}
const hasProp = (p) => typeof p.prop === 'string' && p.prop !== 'none';

const star = (x, y, s, delay = 0, fill = '#fff') =>
  `<path class="cm-twinkle" style="animation-delay:${delay}s" fill="${fill}" d="M${x} ${y - 10 * s}l${3 * s} ${7 * s} ${7 * s} ${3 * s}-${7 * s} ${3 * s}-${3 * s} ${7 * s}-${3 * s}-${7 * s}-${7 * s}-${3 * s} ${7 * s}-${3 * s}z"/>`;

// ---------------------------------------------------------------------------
// Night: a moon, a few stars, a lamp's warm cone, the cool glow of a screen
// ---------------------------------------------------------------------------

/** A thin crescent moon opening to the right, with a faint halo. */
const moon = (cx, cy, r) =>
  `<circle cx="${cx}" cy="${cy}" r="${n1(r * 1.9)}" fill="${MOON}" opacity=".07"/>` +
  `<path class="cm-moon" d="M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${n1(r * 0.62)} ${r} 0 0 1 ${cx} ${cy - r}z" fill="${MOON}"/>`;
const dimStar = (x, y, r, delay) => `<circle class="cm-twinkle" style="animation-delay:${delay}s" cx="${x}" cy="${y}" r="${r}" fill="${MOON}" opacity=".8"/>`;
/** Nested soft shapes in place of a blur: `shape(grow)` draws one at a size, the outer ones fainter. */
const glow = (shape, fill, steps = [[48, 0.05], [28, 0.06], [12, 0.08]]) => steps.map(([g, o]) => shape(g).replace('/>', ` fill="${fill}" opacity="${o}"/>`)).join('');
/** A halo of screen light behind a person, so a dark outline still reads on the dark plate. */
const backlight = (cx, cy, rx, ry) => glow((g) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx + g}" ry="${ry + g}"/>`, SCREEN_TEXT, [[30, 0.04], [14, 0.05], [0, 0.06]]);
/** Sky for any scene: the moon near the top right, a few stars. */
const nightSky = (w) => moon(w - 58, 50, 20) + dimStar(Math.round(w * 0.42), 30, 2, 0.6) + dimStar(Math.round(w * 0.7), 92, 1.6, 1.4) + dimStar(26, 70, 1.8, 0.2);
/** A cone of warm light from (x0..x1, y0) at the lamp down to (x2..x3, y1): two layers, the inner brighter. */
function cone(x0, x1, y0, x2, x3, y1) {
  const mid = (a, b, k) => n1(a + (b - a) * k);
  const inner = `M${mid(x0, x1, 0.2)} ${y0}L${mid(x2, x3, 0.18)} ${y1}H${mid(x2, x3, 0.82)}L${mid(x0, x1, 0.8)} ${y0}z`;
  return `<path class="cm-cone" d="M${x0} ${y0}L${x2} ${y1}H${x3}L${x1} ${y0}z" fill="${LAMP}" opacity=".13"/><path d="${inner}" fill="${LAMP}" opacity=".12"/>`;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * Each scene returns { svg, lines } where `lines` is the screen's box
 * { x, y, w, h } in art units (or null): comic.js types the screen lines as
 * HTML there. `ctx` is { w, night }: the art's width and whether the panel is
 * on the night background.
 */
const SCENE_ART = {
  desk: (p, { night }) => {
    const who = member(p, 0);
    if (!night) {
      return {
        svg:
          star(640, 56, 1.1, 0.4, '#f0a548') + star(36, 40, 0.9, 1.2, '#f0a548') +
          // the monitor, standing on the desk
          `<path d="M478 250h44l10 14h-64z" fill="#26305a" ${line()} stroke-linejoin="round"/>` +
          `<rect x="330" y="132" width="338" height="118" rx="10" fill="#26305a" ${line()}/><rect x="342" y="144" width="314" height="94" rx="4" fill="${SCREEN_BG}"/>` +
          `<rect class="cm-scan" x="342" y="144" width="314" height="12" fill="${SCREEN_TEXT}" opacity="0"/>` +
          bust(who, 40, 94, 160, 'cm-tilt') +
          // the desk in front of them
          `<rect y="262" width="697" height="58" fill="${INK}"/><rect x="0" y="248" width="697" height="16" fill="#26305a" ${line()}/>` +
          `<rect x="270" y="224" width="26" height="24" rx="4" fill="#fff" ${line(3)}/><path d="M296 230c10 0 10 14 0 14" fill="none" ${line(3)}/>` +
          (hasProp(p) ? prop(p.prop, 214, 186, 0.62, 'cm-twinkle') : ''),
        lines: SCREENS.desk.lines,
      };
    }
    // Late at night: the monitor is the main light, a desk lamp throws a warm cone on the desk.
    return {
      svg:
        nightSky(697) +
        glow((g) => `<rect x="${330 - g}" y="${132 - g}" width="${338 + 2 * g}" height="${118 + 2 * g}" rx="${10 + g}"/>`, SCREEN_TEXT) +
        backlight(120, 178, 82, 74) +
        cone(288, 324, 140, 226, 362, 250) +
        `<path d="M478 250h44l10 14h-64z" fill="#26305a" ${line()} stroke-linejoin="round"/>` +
        `<rect x="330" y="132" width="338" height="118" rx="10" fill="#26305a" ${line()}/><rect x="342" y="144" width="314" height="94" rx="4" fill="${SCREEN_BG}"/>` +
        `<rect x="342" y="144" width="314" height="94" rx="4" fill="${SCREEN_TEXT}" opacity=".08"/>` +
        `<rect class="cm-scan" x="342" y="144" width="314" height="12" fill="${SCREEN_TEXT}" opacity="0"/>` +
        // the lamp: a base on the desk, a jointed arm, a shade over a bulb
        `<path d="M310 242L296 186L308 134" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="M310 242L296 186L308 134" fill="none" stroke="#56609a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="296" cy="186" r="4.5" fill="#56609a" ${line(3)}/>` +
        `<path d="M296 118h24l10 24h-44z" fill="#f0a548" ${line(3.5)} stroke-linejoin="round"/><ellipse cx="306" cy="143" rx="10" ry="4" fill="${LAMP}" ${line(2.5)}/>` +
        bust(who, 40, 94, 160, 'cm-tilt') +
        `<rect y="262" width="697" height="58" fill="${INK}"/><rect x="0" y="248" width="697" height="16" fill="#26305a" ${line()}/>` +
        `<ellipse cx="294" cy="252" rx="66" ry="5" fill="${LAMP}" opacity=".35"/>` +
        `<rect x="292" y="240" width="36" height="9" rx="3" fill="#56609a" ${line(3)}/>` +
        `<rect x="250" y="224" width="26" height="24" rx="4" fill="#fff" ${line(3)}/><path d="M276 230c10 0 10 14 0 14" fill="none" ${line(3)}/>` +
        (hasProp(p) ? prop(p.prop, 190, 186, 0.62, 'cm-twinkle') : ''),
      lines: SCREENS.desk.lines,
    };
  },
  message: (p, { night, w }) => {
    const who = member(p, 0);
    const flying = hasProp(p) ? p.prop : 'envelope';
    return {
      svg:
        (night ? nightSky(w) + backlight(247, 250, 70, 70) : '') +
        `<g stroke="${INK}" stroke-width="3" stroke-linecap="round" class="cm-trail" opacity=".45"><path d="M4 190h30M0 166h24M10 214h34"/></g>` +
        `<g class="cm-fly">${prop(flying, 22, 164, 1.3)}</g>` +
        star(40, 238, 1, 0.3, '#f0a548') + star(290, 70, 0.8, 1, '#f0a548') +
        bust(who, 172, 166, 150, 'cm-lean'),
      lines: null,
    };
  },
  portrait: (p, { night, w }) => {
    const who = member(p, 0);
    return {
      svg:
        (night ? nightSky(w) : '') +
        `<g class="cm-rays" opacity="${night ? '.14' : '.5'}"><g fill="#fff"><path d="M236 150L186 18h40zM236 150L326 68V8zM236 150l100 28v40zM236 150l50 158h-40zM236 150L146 258v-40zM236 150L116 118V78z"/></g></g>` +
        (night ? backlight(105, 210, 84, 84) : '') +
        bust(who, 10, 112, 190, 'cm-tilt') +
        (hasProp(p) ? prop(p.prop, 232, 210, 1, 'cm-twinkle') : ''),
      lines: null,
    };
  },
  screen: (p, { night, w }) => ({
    svg:
      (night ? nightSky(w) : '') +
      `<g fill="${SCREEN_TEXT}" opacity=".9"><circle class="cm-twinkle" cx="26" cy="30" r="4"/><circle class="cm-twinkle" cx="672" cy="44" r="3" style="animation-delay:.8s"/><circle class="cm-twinkle" cx="670" cy="296" r="5" style="animation-delay:1.3s"/><circle class="cm-twinkle" cx="24" cy="290" r="3" style="animation-delay:.4s"/></g>` +
      (night ? glow((g) => `<rect x="${48 - g}" y="${26 - g}" width="${601 + 2 * g}" height="${226 + 2 * g}" rx="${16 + g}"/>`, SCREEN_TEXT, [[20, 0.05], [8, 0.07]]) : '') +
      `<rect x="48" y="26" width="601" height="226" rx="16" fill="${SCREEN_BG}" stroke="${SCREEN_TEXT}" stroke-width="4"/>` +
      `<rect class="cm-scan" x="52" y="30" width="593" height="16" fill="${SCREEN_TEXT}" opacity="0"/>` +
      `<path d="M290 252h118l22 40H268z" fill="#26305a" stroke="${SCREEN_TEXT}" stroke-width="4" stroke-linejoin="round"/>`,
    lines: SCREENS.screen.lines,
  }),
  duo: (p, { night }) => {
    const [a, b] = [member(p, 0), member(p, 1)];
    if (!night) {
      return {
        svg:
          star(300, 100, 0.9, 0.5, '#f0a548') +
          bust(a, 6, 172, 156, 'cm-lean') + bust(b, 176, 160, 156, 'cm-tilt') +
          (hasProp(p) ? prop(p.prop, 140, 250, 0.5, 'cm-twinkle') : ''),
        lines: null,
      };
    }
    // A pendant lamp between them lights both faces; the moon sits in the top left, out of the bubbles' way.
    return {
      svg:
        moon(46, 46, 18) + dimStar(300, 104, 1.8, 0.5) + dimStar(110, 26, 1.5, 1.1) +
        cone(150, 186, 56, 18, 318, 320) +
        `<path d="M168 0v32" stroke="#56609a" stroke-width="3"/>` +
        `<path d="M150 32h36l14 24h-64z" fill="#f0a548" ${line(3.5)} stroke-linejoin="round"/><ellipse cx="168" cy="57" rx="11" ry="4" fill="${LAMP}" ${line(2.5)}/>` +
        bust(a, 6, 172, 156, 'cm-lean') + bust(b, 176, 160, 156, 'cm-tilt') +
        (hasProp(p) ? prop(p.prop, 140, 250, 0.5, 'cm-twinkle') : ''),
      lines: null,
    };
  },
  you: (p, { night }) => ({
    svg:
      (night ? moon(470, 50, 18) : '') +
      star(60, 60, 1.3, 0, '#fff') + star(572, 78, 1, 0.7) + star(340, 40, 0.8, 1.2) + star(650, 250, 1, 0.3) +
      (night ? backlight(265, 110, 80, 70) : '') +
      bust('you', 190, 24, 150, 'cm-char-you') +
      `<rect x="20" y="164" width="424" height="140" rx="12" fill="#fff" ${line()}/><rect x="32" y="176" width="400" height="118" rx="6" fill="${SCREEN_BG}"/>` +
      `<path d="M4 304h452l-18 16H22z" fill="#b3b9d1" ${line()} stroke-linejoin="round"/>`,
    lines: SCREENS.you.lines,
  }),

  /**
   * The black card: a near-black plate with film grain and a vignette, and a thin
   * ruled band in the middle (`stack`) where comic.js sets the caption lines as HTML.
   */
  black: (p, { w }) => {
    const band = { x: 60, y: 88, w: w - 120, h: 144 };
    const x1 = band.x + band.w;
    const rule = (y, extra = '') => `<path d="M${band.x} ${y}H${x1}" stroke="${BLACK_RULE}" stroke-width="1.5"${extra}/>`;
    return {
      svg:
        `<rect width="${w}" height="${ART.h}" fill="${BLACK}"/>` +
        `<defs><radialGradient id="cm-vignette" cx="50%" cy="50%" r="72%"><stop offset="50%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".75"/></radialGradient></defs>` +
        grain(w, ART.h) +
        `<rect width="${w}" height="${ART.h}" fill="url(#cm-vignette)"/>` +
        `<g class="cm-rules">` +
        rule(band.y) + rule(band.y + band.h) +
        [1, 2, 3].map((k) => rule(band.y + (band.h * k) / 4, ' stroke-dasharray="2 7" opacity=".45"')).join('') +
        `<path d="M${band.x} ${band.y - 8}v16M${x1} ${band.y - 8}v16M${band.x} ${band.y + band.h - 8}v16M${x1} ${band.y + band.h - 8}v16" stroke="${BLACK_RULE}" stroke-width="1.5"/>` +
        `</g>`,
      lines: null,
      stack: band,
    };
  },

  /**
   * The diagram card: a rounded plate inset from the panel's edge (so the panel's
   * own background shows round it as a tinted frame), holding an empty port that
   * applyDiagramStep fills with the diagram player's picture.
   */
  diagram: (p, { w, night }) => {
    // One person may present it: drawn small at the bottom left, the port moved over to make room.
    const presenter = Array.isArray(p.cast) && castEntry(p.cast[0]) ? member(p, 0) : null;
    const px = presenter ? 132 : 30;
    return {
      svg:
        (night ? nightSky(w) : '') +
        `<g class="diagram cm-dgm cm-dgm-idle">` +
        `<rect class="cm-dgm-plate" x="16" y="16" width="${w - 32}" height="${ART.h - 32}" rx="18" fill="${DGM_PLATE}" ${line()}/>` +
        `<svg class="cm-dgm-port" x="${px}" y="28" width="${w - px - 30}" height="${ART.h - 56}" overflow="hidden"></svg>` +
        `</g>` +
        (presenter ? bust(presenter, 4, 186, 124, 'cm-lean') : ''),
      lines: null,
    };
  },
};

/** Film grain: specks scattered by a fixed seed, so the same card always draws the same. */
function grain(w, h, n = 120) {
  let s = 2463534242;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  let dots = '';
  for (let i = 0; i < n; i++) {
    dots += `<circle cx="${n1(rnd() * w)}" cy="${n1(rnd() * h)}" r="${n1(0.5 + rnd() * 0.9)}" fill-opacity="${(0.05 + rnd() * 0.12).toFixed(2)}"/>`;
  }
  return `<g class="cm-grain" fill="#fff">${dots}</g>`;
}

/**
 * The art for one panel: `{ svg, lines, viewBox, width, height }`, svg being the
 * inside of an <svg> element whose viewBox is `viewBox`. The panel's background
 * colour is the panel's own (CSS), so the art draws no ground, except the black
 * card, which is its own plate. The black card also returns `stack`, the ruled
 * box for its captions. A scene the art does not know draws nothing.
 */
export function sceneArt(panel) {
  const scene = panel?.scene;
  const draw = typeof scene === 'string' && Object.hasOwn(SCENE_ART, scene) ? SCENE_ART[scene] : null;
  const w = artWidth(scene);
  const out = draw ? draw(panel, { w, night: panel.bg === 'night' }) : { svg: '', lines: null };
  const art = { svg: out.svg, lines: out.lines, viewBox: `0 0 ${w} ${ART.h}`, width: w, height: ART.h };
  if (out.stack) art.stack = out.stack;
  return art;
}

/** Whether a scene shows its caption as the big display words (the closing panel), not a small box. */
export const captionIsDisplay = (scene) => scene === 'you';

/**
 * Whether a caption tells the time ("23:47", "Saturday 03:12"): it is then set like a clock
 * (`.cm-caption--clock`, mono with figures of one width). Any caption with an H:MM or HH:MM in it.
 */
export const isClockCaption = (text) => typeof text === 'string' && /\b\d{1,2}:\d{2}\b/.test(text);

// ---------------------------------------------------------------------------
// The diagram card's picture
// ---------------------------------------------------------------------------

let byId = null;
/** The library diagram a panel names, or null. */
export function diagramFor(panel) {
  if (!byId) byId = new Map((library.diagrams || []).map((d) => [d.id, d]));
  const id = panel && typeof panel === 'object' ? panel.diagram : undefined;
  return typeof id === 'string' && byId.has(id) ? byId.get(id) : null;
}

/** The first element under `root` (itself included) carrying class `cls`, by querySelector or by walking. */
function findByClass(root, cls) {
  if (!root || typeof root !== 'object') return null;
  const has = (el) => typeof el.getAttribute === 'function' && String(el.getAttribute('class') || '').split(/\s+/).includes(cls);
  if (has(root)) return root;
  if (typeof root.querySelector === 'function') {
    try {
      return root.querySelector(`.${cls}`);
    } catch {
      return null;
    }
  }
  for (const c of root.children || []) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

function empty(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** The player behind each port, so a step change redraws in place instead of building anew. */
const players = new WeakMap();

/** Whether the diagram must sit still: the comic is reduced, under test or done, or the reader asks for less motion. */
function stillFor(figEl, doc) {
  const cm = typeof figEl.closest === 'function' ? figEl.closest('.cm') : null;
  if (cm && typeof cm.getAttribute === 'function') {
    if (cm.getAttribute('data-reduced') != null || cm.getAttribute('data-test') != null || cm.getAttribute('data-state') === 'done') return true;
  }
  const win = doc.defaultView || null;
  try {
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** Stops and forgets the diagram player of a panel (comic.js calls it when the panel goes). */
export function releaseDiagram(figEl) {
  const port = findByClass(figEl, 'cm-dgm-port');
  const p = port && players.get(port);
  if (!p) return;
  players.delete(port);
  try {
    p.root.destroy();
  } catch {
    /* already gone */
  }
  empty(port);
}

/**
 * Shows step `step` (0-based) of the panel's diagram in the frame sceneArt drew
 * for it: `figEl` is the panel's element (anything holding that art). `step` -1
 * (or anything not a number) is "nothing yet": the boxes and lines ghosted,
 * nothing lit, nothing travelling. A step past the end shows the last one.
 *
 * The picture is diagram.js's own: its player is built off the page with no
 * autoplay, its picture moved into the frame's port (a nested <svg> that keeps
 * the diagram's viewBox, so it scales to the panel), and stepped with goTo.
 * Under reduced motion, the test clock or a finished comic the player is built
 * reduced, so packets rest on their lines instead of travelling.
 *
 * Never throws. An id the library does not have, or a page with no frame, leaves
 * the frame empty. Returns the step shown (-1 for none).
 */
export function applyDiagramStep(figEl, panel, step) {
  try {
    const port = findByClass(figEl, 'cm-dgm-port');
    if (!port) return -1;
    const frame = findByClass(figEl, 'cm-dgm');
    const setIdle = (on) => frame && frame.classList && frame.classList.toggle('cm-dgm-idle', on);
    const d = diagramFor(panel);
    const doc = port.ownerDocument || figEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!d || !doc) {
      releaseDiagram(figEl);
      empty(port);
      setIdle(true);
      return -1;
    }
    const still = stillFor(figEl, doc);
    let p = players.get(port);
    if (!p || p.id !== d.id || p.still !== still) {
      releaseDiagram(figEl);
      empty(port);
      const root = renderDiagram(d, { document: doc, autoplay: false, reducedMotion: still });
      const pic = findByClass(root, 'diagram-svg');
      if (!pic) {
        root.destroy();
        return -1;
      }
      pic.setAttribute('width', '100%');
      pic.setAttribute('height', '100%');
      port.appendChild(pic);
      p = { id: d.id, still, root, shown: null };
      players.set(port, p);
    }
    const total = Array.isArray(d.steps) ? d.steps.length : 0;
    const want = typeof step === 'number' && Number.isFinite(step) ? Math.trunc(step) : -1;
    const shown = want < 0 || total === 0 ? -1 : Math.min(want, total - 1);
    if (shown !== p.shown) {
      // goTo sends the step's packets on their way (or, still, sets them down); "nothing yet" only hides what is drawn.
      if (shown >= 0) p.root.goTo(shown);
      p.shown = shown;
    }
    setIdle(shown < 0);
    if (frame && typeof frame.setAttribute === 'function') frame.setAttribute('data-step', String(shown));
    return shown;
  } catch {
    return -1;
  }
}
