import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every tab in the console has to resolve to a view element.
 *
 * `showView` maps a tab's `data-view` to an element id, and a tab added
 * without a map entry dereferenced null — which `enterSession` swallowed
 * into the launcher's error line, so no lab could be started at all. The
 * markup and the map are edited in different files, so nothing but a test
 * keeps them in agreement.
 */
const html = readFileSync('dashboard/public/index.html', 'utf8');
const app = readFileSync('dashboard/src/app.js', 'utf8');

function viewMap(): Record<string, string> {
  const line = app.match(/const map = \{([^}]*)\};/);
  if (!line) throw new Error('showView map not found');
  return Object.fromEntries(
    line[1]!
      .split(',')
      .map((pair) => pair.split(':').map((p) => p.trim().replace(/^['"]|['"]$/g, '')))
      .filter((pair) => pair.length === 2 && pair[0])
      .map(([k, v]) => [k!, v!])
  );
}

describe('console tabs and views', () => {
  const map = viewMap();
  // The workspace window's tabs; a service's tab has no data-view (openService picks the view).
  const tabs = [...html.matchAll(/class="tab[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1]!);

  it('finds the tabs it is meant to check', () => {
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    expect(tabs).toContain('terminal');
    expect(tabs).toContain('editor');
  });

  it('maps every tab to a view id', () => {
    for (const tab of tabs) expect(map[tab], `tab "${tab}" has no showView entry`).toBeTruthy();
  });

  it('points every mapped id at an element that exists', () => {
    for (const [view, id] of Object.entries(map)) {
      expect(html.includes(`id="${id}"`), `view "${view}" maps to missing #${id}`).toBe(true);
    }
  });

  it('gives every id the console looks up an element in the markup', () => {
    // $('x') is the console's only lookup helper, so an id it asks for that
    // the markup never defines is a null deref waiting to happen.
    const ids = new Set([...app.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]!));
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    expect(missing, `ids used by app.js but absent from index.html: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * The guide's tabs are the same kind of pair: a tab in the markup, a panel it controls, and the
 * id session-layout.js and app.js know it by. Each is edited in a different file.
 */
describe('the guide tabs and their panels', () => {
  const layout = readFileSync('dashboard/src/session-layout.js', 'utf8');
  const known = [...layout.slice(layout.indexOf('export const GUIDE_TABS'), layout.indexOf('};', layout.indexOf('export const GUIDE_TABS'))).matchAll(/^\s+(\w+):\s*'/gm)].map((m) => m[1]!);
  const tabs = [...html.matchAll(/<button[^>]*class="tab gtab"[^>]*data-guide-tab="(\w+)"[^>]*aria-controls="(\w+)"/g)].map((m) => ({ id: m[1]!, panel: m[2]! }));
  const panels = Object.fromEntries(
    [...app.slice(app.indexOf('const GUIDE_PANEL = {'), app.indexOf('};', app.indexOf('const GUIDE_PANEL = {'))).matchAll(/^\s+(\w+):\s*'(\w+)'/gm)].map((m) => [m[1]!, m[2]!])
  );

  it('has a tab in the markup for every tab the layout module knows, and no other', () => {
    expect(known.length).toBeGreaterThanOrEqual(7);
    expect(tabs.map((t) => t.id).sort()).toEqual([...known].sort());
  });

  it('controls the panel app.js shows for it, and that panel exists and is labelled by the tab', () => {
    for (const { id, panel } of tabs) {
      expect(panels[id], `app.js has no panel for "${id}"`).toBe(panel);
      expect(html.includes(`id="${panel}"`), `#${panel} is missing`).toBe(true);
      expect(html.includes(`aria-labelledby="tab${id[0]!.toUpperCase()}${id.slice(1)}"`), `#${panel} is not labelled by its tab`).toBe(true);
    }
  });

  it('gives every tab an id app.js can find it by, and a rail icon', () => {
    for (const { id } of tabs) {
      expect(html.includes(`id="tab${id[0]!.toUpperCase()}${id.slice(1)}"`), `tab "${id}" has no id`).toBe(true);
      expect(new RegExp(`${id}:\\s*'i-[a-z]+'`).test(app), `no rail icon for "${id}"`).toBe(true);
    }
  });

  it('has every sprite glyph the rail and tabs point at', () => {
    const icons = [...app.slice(app.indexOf('const RAIL_ICON = {'), app.indexOf('};', app.indexOf('const RAIL_ICON = {'))).matchAll(/'(i-[a-z]+)'/g)].map((m) => m[1]!);
    expect(icons.length).toBeGreaterThanOrEqual(7);
    for (const id of icons) expect(html.includes(`<symbol id="${id}"`), `no <symbol id="${id}">`).toBe(true);
    for (const use of html.matchAll(/<use href="#([\w-]+)"/g)) expect(html.includes(`<symbol id="${use[1]}"`), `<use href="#${use[1]}"> has no symbol`).toBe(true);
  });
});
