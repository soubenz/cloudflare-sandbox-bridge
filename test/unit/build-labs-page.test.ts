import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Lab {
  slug: string;
  title: string;
  summary?: string;
  type?: string;
  path: string;
  module?: number;
  order?: number;
  tier?: string;
  estimated_minutes?: number;
  difficulty?: string;
}
interface LabsPageModule {
  renderLabsPage: (labs: Lab[]) => string;
  loadLabs: () => Lab[];
  truncateSummary: (text: string, limit?: number) => string;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let mod: LabsPageModule;
let committed: string;

beforeAll(async () => {
  // Computed specifier: the .mjs has no types and allowJs is off.
  mod = (await import(pathToFileURL(join(repoRoot, 'scripts', 'build-labs-page.mjs')).href)) as LabsPageModule;
  committed = readFileSync(join(repoRoot, 'site', 'public', 'labs.html'), 'utf8');
});

function lab(over: Partial<Lab> & Pick<Lab, 'slug' | 'path'>): Lab {
  return {
    title: over.slug,
    summary: `Summary of ${over.slug}.`,
    type: 'build',
    module: 1,
    order: 1,
    tier: 'pro',
    estimated_minutes: 30,
    difficulty: 'core',
    ...over,
  };
}

/** The titles of the cards, in page order. */
function titles(html: string): string[] {
  return [...html.matchAll(/<h4>(.*?)<\/h4>/g)].map((m) => m[1] ?? '');
}

describe('renderLabsPage on fixture data', () => {
  const fixture: Lab[] = [
    lab({ slug: 'z-last-platform', title: 'Z last platform', path: 'ai-platform', module: 2, order: 1 }),
    lab({ slug: 'b-second', title: 'B second in module 1', path: 'ai-platform', module: 1, order: 2 }),
    lab({ slug: 'a-first', title: 'A first in module 1', path: 'ai-platform', module: 1, order: 1, tier: 'free' }),
    lab({ slug: 'p2', title: 'Second agent lab', path: 'production-agents', order: 2 }),
    lab({ slug: 'p1', title: 'First agent lab', path: 'production-agents', order: 1, tier: 'free', type: 'break-fix' }),
    lab({ slug: 'sec', title: 'A security lab', path: 'securing-agents' }),
    // A fixture lab with no path is never passed in: loadLabs filters it out.
  ];

  it('lists paths in the fixed order and labs by module then order', () => {
    const html = mod.renderLabsPage(fixture);
    expect(titles(html)).toEqual([
      'First agent lab',
      'Second agent lab',
      'A security lab',
      'A first in module 1',
      'B second in module 1',
      'Z last platform',
    ]);
    const ids = [...html.matchAll(/<section class="labs-path" id="([a-z-]+)"/g)].map((m) => m[1] ?? '');
    expect(ids).toEqual(['production-agents', 'securing-agents', 'ai-platform']);
  });

  it('prints module headings only for a path with more than one module', () => {
    const html = mod.renderLabsPage(fixture);
    const headings = [...html.matchAll(/<h3><span class="mono">(\d)<\/span> ([^<]+)<\/h3>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(headings).toEqual(['1 Gateway and access', '2 Tools and MCP']);
  });

  it('computes the counts line from the data', () => {
    const html = mod.renderLabsPage(fixture);
    expect(html).toContain('6 labs &middot; 3 paths &middot; 2 platform modules');
  });

  it('gives a free lab a Try it link and a pro lab a waitlist link', () => {
    const html = mod.renderLabsPage(fixture);
    const cards = html.split('<li class="lab-card').slice(1);
    const free = cards.find((c) => c.includes('First agent lab'))!;
    const pro = cards.find((c) => c.includes('Second agent lab'))!;
    expect(free).toContain('href="/try"');
    expect(free).toContain('>Try it</a>');
    expect(free).toContain('lab-chip-free">Free<');
    expect(free).not.toContain('/waitlist');
    expect(pro).toContain('href="/waitlist?from=labs"');
    expect(pro).toContain('>Join the waitlist</a>');
    expect(pro).toContain('lab-chip-pro">Pro<');
    expect(pro).not.toContain('href="/try"');
  });

  it('shows type, minutes and difficulty chips, and omits difficulty when unset', () => {
    const html = mod.renderLabsPage([lab({ slug: 'x', title: 'X', path: 'production-agents', difficulty: undefined, type: 'explore', estimated_minutes: 15 })]);
    expect(html).toContain('<span class="lab-chip">explore</span><span class="lab-chip">~15 min</span><span class="lab-chip lab-chip-pro">Pro</span>');
  });

  it('says more labs are planned for securing-agents and evals-releases only', () => {
    const html = mod.renderLabsPage([
      lab({ slug: 'a', path: 'production-agents' }),
      lab({ slug: 'b', path: 'securing-agents' }),
      lab({ slug: 'c', path: 'ai-platform' }),
      lab({ slug: 'd', path: 'evals-releases' }),
    ]);
    const sections = html.split('<section class="labs-path"').slice(1);
    const planned = sections.map((s) => s.includes('More labs are planned'));
    expect(planned).toEqual([false, true, false, true]);
  });

  it('escapes everything that comes from a manifest', () => {
    const html = mod.renderLabsPage([
      lab({
        slug: 'evil',
        title: '<img src=x onerror=alert(1)> & "quotes"',
        summary: '<script>alert("x")</script> it\'s',
        type: '<b>build</b>',
        difficulty: '"><svg>',
        path: 'production-agents',
      }),
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<svg>');
    expect(html).not.toContain('<b>build</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; it&#39;s');
    // The aria-label attribute carries the title, so it must be escaped too.
    expect(html).toContain('aria-label="Join the waitlist: &lt;img');
  });

  it('refuses a lab whose path is not on the page, instead of dropping it', () => {
    expect(() => mod.renderLabsPage([lab({ slug: 'lost', path: 'no-such-path' })])).toThrow(/no-such-path/);
  });

  it('ships no script and no inline event handlers', () => {
    const html = mod.renderLabsPage(fixture);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('is deterministic', () => {
    expect(mod.renderLabsPage(fixture)).toBe(mod.renderLabsPage([...fixture].reverse()));
  });
});

describe('truncateSummary', () => {
  it('leaves short text alone and collapses whitespace', () => {
    expect(mod.truncateSummary('one\n  two   three')).toBe('one two three');
  });

  it('cuts at a word boundary within about 200 characters and adds an ellipsis', () => {
    const text = 'word '.repeat(80).trim();
    const out = mod.truncateSummary(text);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.slice(0, -1).split(' ').every((w) => w === 'word')).toBe(true);
  });
});

describe('the committed labs page', () => {
  it('equals a fresh render from the real manifests (run: node scripts/build-labs-page.mjs)', () => {
    expect(committed).toBe(mod.renderLabsPage(mod.loadLabs()));
  });

  it('has exactly two free labs: duplicate-emails and weekend-bill', () => {
    const labs = mod.loadLabs();
    const free = labs.filter((l) => l.tier === 'free').map((l) => l.slug).sort();
    expect(free).toEqual(['duplicate-emails', 'weekend-bill']);
    expect(labs.filter((l) => l.tier !== 'free').every((l) => l.tier === 'pro')).toBe(true);
    // One Try it link per free lab, and every other card points at the waitlist.
    expect(committed.match(/href="\/try"/g)?.length ?? 0).toBe(2 + 1 /* the nav button */);
    expect(committed.match(/lab-chip-free/g)?.length ?? 0).toBe(2);
    expect(committed.match(/lab-chip-pro/g)?.length ?? 0).toBe(labs.length - 2);
  });

  it('mentions the lab count computed from the manifests that have a path', () => {
    const labs = mod.loadLabs();
    expect(labs.length).toBeGreaterThan(0);
    expect(committed).toContain(`${labs.length} labs &middot; 4 paths &middot; 7 platform modules`);
    expect(committed.match(/<li class="lab-card/g)?.length).toBe(labs.length);
    expect(committed).toContain(`${labs.length} labs in the beta`);
  });
});
