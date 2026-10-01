/**
 * The motion comic's art, drawn from code: the cast as simple geometric busts,
 * a handful of props, and one SVG scene per template (desk, message, portrait,
 * screen, duo, you). Nothing here is an image and nothing here knows about
 * time; comic.js lays the art in a panel and the timeline decides when what
 * shows. The look is the design's StoryComic: thick navy outlines, flat fills,
 * a few ambient loops (bob, blink, twinkle) that comic.css switches off for
 * reduced motion, for a finished comic and for the test clock.
 *
 * The strings built here contain no text from a lab: words, captions and
 * screen lines are drawn as HTML over the art (comic.js, with textContent), so
 * assigning these strings to innerHTML never puts content someone wrote into
 * markup. Colours that belong to the interface are variables (--cm-*, from
 * styles.css, light and dark); the people's own colours are drawn here.
 */

import { SCENES } from '../../src/labs/comic-kit.ts';
import { SCREENS } from './comic-timeline.js';

const INK = 'var(--cm-ink)';
const SCREEN_BG = 'var(--cm-screen-bg)';
const SCREEN_TEXT = 'var(--cm-screen-text)';

/** Panel art sizes in art units: the height is fixed, a wide panel is twice the width of a square one plus a gutter. */
export const ART = { h: 320, wide: 697, square: 337 };
export const artWidth = (scene) => (SCENES[scene].span === 2 ? ART.wide : ART.square);

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

const line = (w = 4) => `stroke="${INK}" stroke-width="${w}"`;
const body = (shirt) => `<path d="M8 130c2-30 22-42 52-42s50 12 52 42z" fill="${shirt}" ${line()} stroke-linejoin="round"/>`;
const neck = (skin) => `<rect x="50" y="70" width="20" height="22" rx="8" fill="${skin}" ${line()}/>`;
const head = (skin) => `<path d="M26 52c0-26 14-38 34-38s34 12 34 38c0 20-14 36-34 36S26 72 26 52z" fill="${skin}" ${line()}/>`;
const eyes = (y = 57, r = 4.5, l = 48, rr = 74) => `<circle class="cm-eye" cx="${l}" cy="${y}" r="${r}" fill="${INK}"/><circle class="cm-eye" cx="${rr}" cy="${y}" r="${r}" fill="${INK}"/>`;
const smile = (d = 'M50 74c6 6 16 6 22 0') => `<path class="cm-mouth" d="${d}" fill="none" ${line()} stroke-linecap="round"/>`;
const collar = '<path d="M48 88l12 14 12-14" fill="#fff" ' + line() + ' stroke-linejoin="round"/>';

/**
 * Each bust is drawn on a 120 by 130 board. What tells them apart at a glance:
 *   maren   dark swept fringe, cobalt jacket with a white collar        (platform lead)
 *   tomasz  short brown hair, round glasses, teal                        (staff engineer)
 *   jonas   grey hair, heavy brows, amber                                (finance)
 *   priya   long dark hair, a support headset with a microphone, rose    (head of support)
 *   anneke  blond bob, square glasses, violet, a lanyard with a badge    (data protection)
 *   you     a plain dark silhouette: the learner
 */
const BUSTS = {
  maren: () =>
    body('#3552f2') + collar + neck('#f1c7a1') + head('#f1c7a1') +
    `<path d="M22 58c-6-34 14-50 40-50 26 0 42 18 36 50-4-14-10-22-18-26-14 6-34 8-50-4-4 6-6 18-8 30z" fill="#1c2446" ${line()} stroke-linejoin="round"/>` +
    eyes(56) + smile(),
  tomasz: () =>
    body('#0e8577') + neck('#e8b98f') + head('#e8b98f') +
    `<path d="M26 46c0-24 14-36 34-36s34 12 34 36c-8-10-16-14-34-14s-26 4-34 14z" fill="#5a3a22" ${line()} stroke-linejoin="round"/>` +
    `<circle cx="46" cy="58" r="10" fill="#fff" fill-opacity=".55" ${line(3.5)}/><circle cx="76" cy="58" r="10" fill="#fff" fill-opacity=".55" ${line(3.5)}/><path d="M56 58h10" ${line(3.5)}/>` +
    eyes(58, 3.5, 46, 76) + smile('M52 77c6 4 14 4 20-2'),
  jonas: () =>
    body('#f0a04b') + collar + neck('#f3d2b3') + head('#f3d2b3') +
    `<path d="M28 44c2-20 14-32 32-32s30 12 32 32c-6-8-12-12-32-12s-26 4-32 12z" fill="#9aa3c7" ${line()} stroke-linejoin="round"/>` +
    eyes(58) + `<path d="M42 48l12-4M80 48l-12-4" ${line()} stroke-linecap="round"/>` +
    `<ellipse class="cm-mouth" cx="61" cy="77" rx="8" ry="5" fill="${INK}"/>`,
  priya: () =>
    `<path d="M14 126c-8-44-2-100 46-104 48 4 54 60 46 104z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    body('#d02650') +
    `<path d="M24 88c-6 14-8 28-6 40h16c0-14 2-28 6-38z" fill="#241611" ${line()} stroke-linejoin="round"/><path d="M96 88c6 14 8 28 6 40H86c0-14-2-28-6-38z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    neck('#c98f66') + head('#c98f66') +
    `<path d="M26 50c0-24 14-38 34-38s34 14 34 38c-12-4-22-14-28-24-4 12-22 24-40 24z" fill="#241611" ${line()} stroke-linejoin="round"/>` +
    `<path d="M22 58C16 22 40 6 60 6s46 16 38 52" fill="none" stroke="#26305a" stroke-width="5" stroke-linecap="round"/>` +
    `<rect x="14" y="50" width="12" height="24" rx="6" fill="#26305a" ${line(3)}/><rect x="94" y="50" width="12" height="24" rx="6" fill="#26305a" ${line(3)}/>` +
    `<path d="M20 72c0 14 10 22 26 20" fill="none" stroke="#26305a" stroke-width="4" stroke-linecap="round"/><circle cx="48" cy="92" r="5" fill="#26305a" ${line(2.5)}/>` +
    eyes(58) + smile(),
  anneke: () =>
    `<path d="M18 98c-6-50 6-88 42-88s48 38 42 88c-8 2-16-2-20-10H38c-4 8-12 12-20 10z" fill="#e6bf62" ${line()} stroke-linejoin="round"/>` +
    body('#7c3aed') +
    `<path d="M46 90l14 30 14-30" fill="none" stroke="#3552f2" stroke-width="4" stroke-linejoin="round"/><rect x="51" y="112" width="18" height="14" rx="3" fill="#fff" ${line(3)}/><path d="M55 118h10" ${line(2.5)}/>` +
    neck('#f6d9c0') + head('#f6d9c0') +
    `<path d="M26 48c4-22 16-34 34-34s30 12 34 34c-10-6-20-12-26-20-8 10-24 18-42 20z" fill="#e6bf62" ${line()} stroke-linejoin="round"/>` +
    `<rect x="33" y="50" width="24" height="17" rx="4" fill="#fff" fill-opacity=".5" ${line(3.5)}/><rect x="63" y="50" width="24" height="17" rx="4" fill="#fff" fill-opacity=".5" ${line(3.5)}/><path d="M57 57h6" ${line(3.5)}/>` +
    eyes(59, 3.5, 45, 75) + smile('M52 77c6 4 14 4 20 0'),
  you: () =>
    `<path d="M8 130c2-30 22-42 52-42s50 12 52 42z" fill="#9aabff" ${line()} stroke-linejoin="round"/>` +
    `<rect x="50" y="70" width="20" height="22" rx="8" fill="#4a5896" ${line()}/>` +
    `<path d="M26 52c0-26 14-38 34-38s34 12 34 38c0 26-14 40-34 40S26 78 26 52z" fill="#4a5896" ${line()}/>` +
    `<path d="M40 40c6-10 18-14 30-12" fill="none" stroke="#9aabff" stroke-width="4" stroke-linecap="round"/>`,
};

/** A bust at (x, y), `w` wide (the board is 120 by 130). `data-cast` lets the player find who is talking. */
export function bust(id, x, y, w, extra = '') {
  const draw = BUSTS[id] ?? BUSTS.you;
  const h = (w * 130) / 120;
  return `<g class="cm-char ${extra}" data-cast="${id}"><svg x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" viewBox="0 0 120 130" overflow="visible">${draw()}</svg></g>`;
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
  const draw = PROP_ART[name];
  return draw ? `<g transform="translate(${x} ${y}) scale(${scale})"><g class="${cls}">${draw()}</g></g>` : '';
}

const star = (x, y, s, delay = 0, fill = '#fff') =>
  `<path class="cm-twinkle" style="animation-delay:${delay}s" fill="${fill}" d="M${x} ${y - 10 * s}l${3 * s} ${7 * s} ${7 * s} ${3 * s}-${7 * s} ${3 * s}-${3 * s} ${7 * s}-${3 * s}-${7 * s}-${7 * s}-${3 * s} ${7 * s}-${3 * s}z"/>`;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * Each scene returns { svg, lines } where `lines` is the screen's box
 * { x, y, w, h } in art units (or null): comic.js types the screen lines as
 * HTML there. `speaker(id)` marks which bust is talking.
 */
const SCENE_ART = {
  desk: (p) => {
    const who = p.cast[0] ?? 'you';
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
        (p.prop !== 'none' ? prop(p.prop, 214, 186, 0.62, 'cm-twinkle') : ''),
      lines: SCREENS.desk.lines,
    };
  },
  message: (p) => {
    const who = p.cast[0] ?? 'you';
    const flying = p.prop === 'none' ? 'envelope' : p.prop;
    return {
      svg:
        `<g stroke="${INK}" stroke-width="3" stroke-linecap="round" class="cm-trail" opacity=".45"><path d="M4 190h30M0 166h24M10 214h34"/></g>` +
        `<g class="cm-fly">${prop(flying, 22, 164, 1.3)}</g>` +
        star(40, 238, 1, 0.3, '#f0a548') + star(290, 70, 0.8, 1, '#f0a548') +
        bust(who, 172, 166, 150, 'cm-lean'),
      lines: null,
    };
  },
  portrait: (p) => {
    const who = p.cast[0] ?? 'you';
    return {
      svg:
        `<g class="cm-rays" opacity=".5"><g fill="#fff"><path d="M236 150L186 18h40zM236 150L326 68V8zM236 150l100 28v40zM236 150l50 158h-40zM236 150L146 258v-40zM236 150L116 118V78z"/></g></g>` +
        bust(who, 10, 112, 190, 'cm-tilt') +
        (p.prop !== 'none' ? prop(p.prop, 232, 210, 1, 'cm-twinkle') : ''),
      lines: null,
    };
  },
  screen: () => ({
    svg:
      `<g fill="${SCREEN_TEXT}" opacity=".9"><circle class="cm-twinkle" cx="26" cy="30" r="4"/><circle class="cm-twinkle" cx="672" cy="44" r="3" style="animation-delay:.8s"/><circle class="cm-twinkle" cx="670" cy="296" r="5" style="animation-delay:1.3s"/><circle class="cm-twinkle" cx="24" cy="290" r="3" style="animation-delay:.4s"/></g>` +
      `<rect x="48" y="26" width="601" height="226" rx="16" fill="${SCREEN_BG}" stroke="${SCREEN_TEXT}" stroke-width="4"/>` +
      `<rect class="cm-scan" x="52" y="30" width="593" height="16" fill="${SCREEN_TEXT}" opacity="0"/>` +
      `<path d="M290 252h118l22 40H268z" fill="#26305a" stroke="${SCREEN_TEXT}" stroke-width="4" stroke-linejoin="round"/>`,
    lines: SCREENS.screen.lines,
  }),
  duo: (p) => {
    const [a, b] = [p.cast[0] ?? 'you', p.cast[1] ?? 'you'];
    return {
      svg:
        star(300, 100, 0.9, 0.5, '#f0a548') +
        bust(a, 6, 172, 156, 'cm-lean') + bust(b, 176, 160, 156, 'cm-tilt') +
        (p.prop !== 'none' ? prop(p.prop, 140, 250, 0.5, 'cm-twinkle') : ''),
      lines: null,
    };
  },
  you: () => ({
    svg:
      star(60, 60, 1.3, 0, '#fff') + star(572, 78, 1, 0.7) + star(340, 40, 0.8, 1.2) + star(650, 250, 1, 0.3) +
      bust('you', 190, 24, 150, 'cm-char-you') +
      `<rect x="20" y="164" width="424" height="140" rx="12" fill="#fff" ${line()}/><rect x="32" y="176" width="400" height="118" rx="6" fill="${SCREEN_BG}"/>` +
      `<path d="M4 304h452l-18 16H22z" fill="#b3b9d1" ${line()} stroke-linejoin="round"/>`,
    lines: SCREENS.you.lines,
  }),
};

/**
 * The art for one panel: `{ svg, lines, viewBox }`, svg being the inside of an
 * <svg> element whose viewBox is `viewBox`. The panel's background colour is
 * the panel's own (CSS), so the art draws no ground.
 */
export function sceneArt(panel) {
  const draw = SCENE_ART[panel.scene];
  const w = artWidth(panel.scene);
  const { svg, lines } = draw(panel);
  return { svg, lines, viewBox: `0 0 ${w} ${ART.h}`, width: w, height: ART.h };
}

/** Whether a scene shows its caption as the big display words (the closing panel), not a small box. */
export const captionIsDisplay = (scene) => scene === 'you';
