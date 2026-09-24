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
  const tabs = [...html.matchAll(/class="tab[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1]!);

  it('finds the tabs it is meant to check', () => {
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    expect(tabs).toContain('brief');
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
