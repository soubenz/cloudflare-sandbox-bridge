import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Lab {
  archived?: boolean;
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
interface ModuleMeta {
  number: number;
  title: string;
  intro: string;
  outcomes: string[];
  icon: string;
  accent: string;
  optional?: boolean;
}
interface PathMeta {
  slug: string;
  title: string;
  intro: string;
  icon: string;
  accent: string;
  modules: ModuleMeta[];
}
interface Meta {
  paths: PathMeta[];
}
interface LabsPageModule {
  renderLabsPage: (labs: Lab[], meta?: Meta) => string;
  loadLabs: () => Lab[];
  loadPathMeta: () => Meta;
  truncateSummary: (text: string, limit?: number) => string;
  escapeHtml: (value: unknown) => string;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let mod: LabsPageModule;
let committed: string;
let meta: Meta;

beforeAll(async () => {
  // Computed specifier: the .mjs has no types and allowJs is off.
  mod = (await import(pathToFileURL(join(repoRoot, 'scripts', 'build-labs-page.mjs')).href)) as LabsPageModule;
  committed = readFileSync(join(repoRoot, 'site', 'public', 'labs.html'), 'utf8');
  meta = JSON.parse(readFileSync(join(repoRoot, 'packages', 'catalogue', 'paths.json'), 'utf8')) as Meta;
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

  it('prints module cards only for a path the copy gives modules, with the title from the copy', () => {
    const html = mod.renderLabsPage(fixture);
    const headings = [...html.matchAll(/<h3 id="([a-z0-9-]+)-title">([^<]+)<\/h3>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(headings).toEqual([
      `ai-platform-module-1 ${meta.paths.find((p) => p.slug === 'ai-platform')!.modules[0]!.title}`,
      `ai-platform-module-2 ${meta.paths.find((p) => p.slug === 'ai-platform')!.modules[1]!.title}`,
    ]);
    // The single-module paths have no module section at all.
    const agents = html.split('<section class="labs-path"').find((sec) => sec.includes('id="production-agents"'))!;
    expect(agents).not.toContain('labs-module');
  });

  it('computes the counts line from the data', () => {
    const html = mod.renderLabsPage(fixture);
    expect(html).toContain('6 labs &middot; 3 paths &middot; 2 modules');
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
    expect(html).toContain('<span class="lab-chip">Explore</span><span class="lab-chip">~15 min</span><span class="lab-chip lab-chip-pro">Pro</span>');
  });

  it('words every known type and writes an unknown one as it is', () => {
    const html = mod.renderLabsPage([lab({ slug: 'bf', path: 'production-agents', type: 'break-fix' }), lab({ slug: 'odd', path: 'production-agents', type: 'mystery' })]);
    expect(html).toContain('<span class="lab-chip">Fix it</span>');
    expect(html).toContain('<span class="lab-chip">mystery</span>');
  });

  it('shows a warm-up with its type, Start here, ten minutes and Free, and no family chip', () => {
    const html = mod.renderLabsPage([lab({ slug: 'w', title: 'Warm up', path: 'production-agents', type: 'warm-up', tier: 'free', difficulty: 'intro', estimated_minutes: 10 })]);
    expect(html).toContain(
      '<span class="lab-chip">Warm-up</span><span class="lab-chip">Start here</span><span class="lab-chip">~10 min</span><span class="lab-chip">intro</span><span class="lab-chip lab-chip-free">Free</span>',
    );
    expect(html).not.toContain('undefined');
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

  it('leaves an archived lab off the public page, as the launcher does', () => {
    const html = mod.renderLabsPage([...fixture, lab({ slug: 'old-one', title: 'An archived lab', path: 'ai-platform', archived: true })]);
    expect(html).not.toContain('An archived lab');
    expect(html).toBe(mod.renderLabsPage(fixture));
  });

  it('refuses a lab whose path the copy does not describe, instead of dropping it', () => {
    expect(() => mod.renderLabsPage([lab({ slug: 'lost', path: 'no-such-path' })])).toThrow(/no-such-path.*paths\.json/);
  });

  it('ships no script, no inline event handler and no inline style (the CSP stays strict)', () => {
    const html = mod.renderLabsPage(fixture);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/javascript:/i);
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
    expect(committed).toContain(`${labs.length} labs &middot; 4 paths &middot; 7 modules`);
    expect(committed.match(/<li class="lab-card/g)?.length).toBe(labs.length);
    expect(committed).toContain(`${labs.length} labs in the beta`);
  });
});

describe('renderLabsPage with the catalogue copy', () => {
  const copy: Meta = {
    paths: [
      { slug: 'solo', title: 'Solo <path>', intro: 'Intro of solo & "co".', icon: 'bolt', accent: 'blue', modules: [] },
      {
        slug: 'multi',
        title: 'Multi',
        intro: 'Intro of multi.',
        icon: 'no-such-glyph',
        accent: 'not-an-accent',
        modules: [
          { number: 1, title: 'First <b>module</b>', intro: 'About the first.', outcomes: ['Skill one', 'Skill <two>'], icon: 'route', accent: 'teal' },
          { number: 3, title: 'Third', intro: 'About the third.', outcomes: ['Skill three', 'Skill four'], icon: 'plug', accent: 'amber', optional: true },
        ],
      },
    ],
  };
  const labs = [
    lab({ slug: 's1', title: 'S one', path: 'solo', order: 1, tier: 'free', estimated_minutes: 35 }),
    lab({ slug: 's2', title: 'S two', path: 'solo', order: 2, estimated_minutes: 45 }),
    lab({ slug: 'm1a', title: 'M1 a', path: 'multi', module: 1, order: 1, estimated_minutes: 60, tier: 'free' }),
    lab({ slug: 'm1b', title: 'M1 b', path: 'multi', module: 1, order: 2, estimated_minutes: 60 }),
    lab({ slug: 'm3', title: 'M3', path: 'multi', module: 3, order: 1, estimated_minutes: 30 }),
  ];
  let html: string;
  beforeAll(() => {
    html = mod.renderLabsPage(labs, copy);
  });
  const section = (slug: string) => html.split('<section class="labs-path"').find((sec) => sec.includes(`id="${slug}"`))!;

  it('prints each path band with its title, intro, icon, accent and totals from the copy, escaped', () => {
    const solo = section('solo');
    expect(solo).toContain('data-accent="blue"');
    expect(solo).toContain('<h2 id="solo-title">Solo &lt;path&gt;</h2>');
    expect(solo).toContain('Intro of solo &amp; &quot;co&quot;.');
    expect(solo).toContain('PATH 01');
    expect(solo).toMatch(/<span class="labs-tile" aria-hidden="true"><svg [^>]*aria-hidden="true"/);
    expect(solo).toContain('<li>2 labs</li>');
    expect(solo).toContain('<li>about 1 h 20 min</li>');
    expect(solo).toContain('<li>1 free</li>');
    expect(section('multi')).toContain('PATH 02');
  });

  it('prints each module card: eyebrow, title, intro, outcomes, accent, and its own counts', () => {
    const multi = section('multi');
    expect(multi).toContain('id="multi-module-1"');
    expect(multi).toContain('data-accent="teal"');
    expect(multi).toContain('<span class="mono">Module 1</span>');
    expect(multi).toContain('<h3 id="multi-module-1-title">First &lt;b&gt;module&lt;/b&gt;</h3>');
    expect(multi).toContain('About the first.');
    expect(multi).toContain('<p class="labs-skills-label mono">You will learn to</p>');
    expect(multi).toContain('<li>Skill one</li>');
    expect(multi).toContain('<li>Skill &lt;two&gt;</li>');
    // Module 1: 2 labs, 120 min, 1 free. Module 3: 1 lab, 30 min.
    expect(multi).toContain('2 labs &middot; ~2 h &middot; 1 free');
    expect(multi).toContain('1 lab &middot; ~30 min');
    expect(multi).toContain('<span class="mono">Module 3</span>');
    // The module numbers are the manifests', not a running count: a path can skip one.
    expect(multi).not.toContain('Module 2');
  });

  it('marks only the module the copy flags as optional', () => {
    const multi = section('multi');
    expect(multi.match(/labs-badge">Optional</g)?.length).toBe(1);
    const third = multi.split('<section class="labs-module"').find((sec) => sec.includes('id="multi-module-3"'))!;
    expect(third).toContain('data-optional="true"');
    expect(third).toContain('labs-badge">Optional<');
    expect(multi.split('<section class="labs-module"').find((sec) => sec.includes('id="multi-module-1"'))!).not.toContain('Optional');
  });

  it('falls back to the slate accent and a generic glyph for an accent or icon the design does not have', () => {
    const multi = section('multi');
    expect(multi.split('\n')[0]).toContain('data-accent="slate"');
    expect(multi).toMatch(/<svg [^>]*>(<rect [^>]*\/>){4}<\/svg>/); // the four-square "grid" glyph
  });

  it('shows a single-module path as a grid straight under the band', () => {
    const solo = section('solo');
    expect(solo).not.toContain('labs-module');
    expect(solo).toContain('<ul class="lab-grid" role="list">');
    expect(titles(solo)).toEqual(['S one', 'S two']);
  });

  it('is deterministic and does not depend on the order of the labs', () => {
    expect(mod.renderLabsPage([...labs].reverse(), copy)).toBe(html);
  });
});

describe('the committed labs page and the catalogue copy', () => {
  const platform = () => meta.paths.find((p) => p.slug === 'ai-platform')!;
  const labs = () => mod.loadLabs();

  it('reads the copy from packages/catalogue/paths.json: every path title and intro is on the page', () => {
    for (const p of meta.paths) {
      expect(committed, p.slug).toContain(`<h2 id="${p.slug}-title">${mod.escapeHtml(p.title)}</h2>`);
      expect(committed, p.slug).toContain(mod.escapeHtml(p.intro));
      expect(committed, p.slug).toContain(`data-accent="${p.accent}"`);
    }
    // In the order of the copy.
    const ids = [...committed.matchAll(/<section class="labs-path" id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(meta.paths.map((p) => p.slug));
  });

  it('prints every module of the platform path with its title, intro and skills', () => {
    for (const m of platform().modules) {
      expect(committed).toContain(`<h3 id="ai-platform-module-${m.number}-title">${mod.escapeHtml(m.title)}</h3>`);
      expect(committed).toContain(mod.escapeHtml(m.intro));
      for (const skill of m.outcomes) expect(committed).toContain(`<li>${mod.escapeHtml(skill)}</li>`);
    }
    // No module card on a path whose copy lists none.
    expect(committed.match(/<section class="labs-module"/g)?.length).toBe(platform().modules.length);
  });

  it('flags exactly the modules the copy calls optional', () => {
    const optional = platform().modules.filter((m) => m.optional).length;
    expect(optional).toBeGreaterThan(0);
    expect(committed.match(/labs-badge">Optional</g)?.length).toBe(optional);
    expect(committed.match(/data-optional="true"/g)?.length).toBe(optional);
  });

  it('gives every module the lab count and time its manifests add up to', () => {
    for (const m of platform().modules) {
      const inModule = labs().filter((l) => l.path === 'ai-platform' && (l.module ?? 1) === m.number);
      const minutes = inModule.reduce((n, l) => n + (l.estimated_minutes ?? 0), 0);
      const free = inModule.filter((l) => l.tier === 'free').length;
      const head = `${inModule.length} ${inModule.length === 1 ? 'lab' : 'labs'}`;
      const segment = committed.split('<section class="labs-module"').find((sec) => sec.includes(`id="ai-platform-module-${m.number}"`))!;
      const card = segment.slice(0, segment.indexOf('</section>'));
      expect(card, `module ${m.number}`).toContain(`${head} &middot; ~`);
      expect(minutes).toBeGreaterThan(0);
      // The lab cards inside the module are its labs.
      expect(card.match(/<li class="lab-card/g)?.length).toBe(inModule.length);
      if (free) expect(card).toContain('free');
    }
  });

  it('draws every icon inline, with no external file and no script', () => {
    expect(committed).not.toMatch(/<script/i);
    expect(committed).not.toMatch(/<img /i);
    const glyphs = committed.match(/<span class="labs-tile[^"]*" aria-hidden="true"><svg /g)?.length ?? 0;
    expect(glyphs).toBe(meta.paths.length + platform().modules.length);
  });

  it('loads the design tokens and pins the light theme, so the accents cannot flip under a dark system preference', () => {
    expect(committed).toContain('<html lang="en" data-theme="light">');
    expect(committed.indexOf('href="/design/tokens.css"')).toBeGreaterThan(0);
    expect(committed.indexOf('href="/design/tokens.css"')).toBeLessThan(committed.indexOf('href="/styles.css"'));
  });
});
