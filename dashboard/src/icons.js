/**
 * The console's stroke glyphs, built as DOM (never from a string that came from
 * the catalogue): the path and module icons of packages/catalogue/paths.json,
 * looked up in the trusted table in launcher-model.js, and the small glyphs the
 * console draws itself (the theme toggle, the arrow on a primary button).
 *
 * `svgIcon` takes markup this repository wrote, so setting innerHTML on an
 * element it just created is safe; callers must never pass it lab or learner text.
 */
import { ICONS } from './launcher-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgIcon(paths, size = 24, box = 24, stroke = 1.75) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = paths;
  return svg;
}

/** A path or module glyph by the `icon` name of the metadata; `grid` for an unknown one. */
export function icon(name, size = 24) {
  return svgIcon(ICONS[name] ?? ICONS.grid, size);
}

const UI_ICONS = {
  sun: ['<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>', 24],
  moon: ['<path d="M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2z"/>', 24],
  auto: ['<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>', 24],
  arrow: ['<path d="M3 8h10M9 4l4 4-4 4"/>', 16],
  back: ['<path d="M13 8H3M7 4 3 8l4 4"/>', 16],
};

/** One of the console's own glyphs: sun, moon, auto, arrow, back. */
export function uiIcon(name, size = 16) {
  const [paths, box] = UI_ICONS[name];
  return svgIcon(paths, size, box, 1.8);
}
