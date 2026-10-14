import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A lesson cut into short pages (dashboard/src/lesson-pages.js): the pager of the
 * Lessons step shows one of them at a time. Pure module, imported directly.
 */
type Block = { type: string; level?: number; text?: string; id?: string; items?: unknown[]; inline?: Array<{ type: string; text?: string }> };
type Page = { blocks: Block[]; words: number; visual: boolean };
const mod = (await import('../../dashboard/src/lesson-pages.js' as string)) as {
  paginateLesson: (src: string | Block[], o?: { maxWords?: number }) => Page[];
  blockWords: (b: Block) => number;
  clampPage: (n: unknown, count: number) => number;
  PAGE_WORDS: number;
};
const md = (await import('../../dashboard/src/markdown.js' as string)) as { parseMarkdown: (s: string) => Block[] };
const { paginateLesson, clampPage, PAGE_WORDS } = mod;

const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');
const para = (n: number, w?: string) => `${words(n - 1, w)} end.`;
/** The kinds of a page's blocks, as a short string: "hpl" is a heading, a paragraph and a list. */
const shape = (pages: Page[]) => pages.map((p) => p.blocks.map((b) => b.type[0]).join(''));

describe('paginateLesson', () => {
  it('keeps a short lesson on one page', () => {
    const pages = paginateLesson(`${para(40)}\n\n${para(30)}`);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.words).toBe(70);
    expect(pages[0]!.visual).toBe(false);
  });

  it('never returns no pages', () => {
    expect(paginateLesson('')).toEqual([{ blocks: [], words: 0, visual: false }]);
  });

  it('starts a page at every ## heading, and the heading opens it', () => {
    const pages = paginateLesson(`${para(20)}\n\n## First\n\n${para(20)}\n\n## Second\n\n${para(20)}`);
    expect(shape(pages)).toEqual(['p', 'hp', 'hp']);
    expect(pages[1]!.blocks[0]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('keeps a ### heading inside its section, with what follows it', () => {
    const pages = paginateLesson(`## Part\n\n${para(20)}\n\n### Sub\n\n${para(20)}`);
    expect(shape(pages)).toEqual(['hphp']);
  });

  it('cuts a section longer than about 120 words at paragraph boundaries, evenly', () => {
    const pages = paginateLesson([para(60), para(60), para(60), para(60), para(60)].join('\n\n'));
    // 300 words: three pages, never more than 120 each.
    expect(pages).toHaveLength(3);
    for (const p of pages) expect(p.words).toBeLessThanOrEqual(PAGE_WORDS);
    // Nothing lost, nothing reordered.
    expect(pages.flatMap((p) => p.blocks)).toEqual(md.parseMarkdown([para(60), para(60), para(60), para(60), para(60)].join('\n\n')));
  });

  it('evens the pages out rather than leaving a scrap at the end', () => {
    const pages = paginateLesson([para(50), para(50), para(50), para(30)].join('\n\n'));
    // 180 words: two pages of 100 and 80, not 100 + 80 any other way round, and not 150 + 30.
    expect(pages.map((p) => p.words)).toEqual([100, 80]);
  });

  it('cuts at paragraph boundaries only: a paragraph longer than a page is a page of its own', () => {
    const pages = paginateLesson([para(30), para(200), para(30)].join('\n\n'));
    expect(pages.map((p) => p.words)).toEqual([30, 200, 30]);
  });

  it('keeps a list whole, however long', () => {
    const list = Array.from({ length: 12 }, (_, i) => `- item ${i} ${words(12)}`).join('\n');
    const pages = paginateLesson(`${para(40)}\n\n${list}\n\n${para(40)}`);
    const lists = pages.flatMap((p) => p.blocks.filter((b) => b.type === 'list'));
    expect(lists).toHaveLength(1);
    expect(lists[0]!.items).toHaveLength(12);
  });

  it('keeps a paragraph that ends in ":" with the list it introduces', () => {
    const pages = paginateLesson(`${para(70)}\n\n${para(40)}\n\nThe steps are these:\n\n- one ${words(10)}\n- two ${words(10)}\n\n${para(60)}`);
    const withList = pages.find((p) => p.blocks.some((b) => b.type === 'list'))!;
    expect(withList.blocks.map((b) => b.type)).toContain('paragraph');
    const at = withList.blocks.findIndex((b) => b.type === 'list');
    expect(withList.blocks[at - 1]!.inline![0]!.text).toBe('The steps are these:');
  });

  it('keeps a bold line on its own (a heading in all but name) with what follows it', () => {
    const pages = paginateLesson(`${para(100)}\n\n**Words this lab uses**\n\n- one ${words(10)}\n- two ${words(10)}`);
    expect(shape(pages)).toEqual(['p', 'pl']);
  });

  it('lets a lead-in and its list part when together they are longer than a page', () => {
    const list = Array.from({ length: 10 }, (_, i) => `- item ${i} ${words(12)}`).join('\n');
    expect(shape(paginateLesson(`It gives each team:\n\n${list}`))).toEqual(['p', 'l']);
  });

  it('a block too long for a page stands alone and does not stretch the pages around it', () => {
    const list = Array.from({ length: 12 }, (_, i) => `- item ${i} ${words(12)}`).join('\n');
    const pages = paginateLesson([para(60), para(60), para(60), list].join('\n\n'));
    expect(pages.map((p) => p.words).slice(0, -1).every((n) => n <= PAGE_WORDS)).toBe(true);
    expect(shape(pages).at(-1)).toBe('l');
  });

  it('gives a diagram a page of its own, with the paragraph that introduces it', () => {
    const pages = paginateLesson(`${para(50)}\n\n${para(30)}\n\n::diagram[gateway-what-it-does]\n\n${para(50)}`);
    expect(shape(pages)).toEqual(['p', 'pd', 'p']);
    expect(pages.map((p) => p.visual)).toEqual([false, true, false]);
    expect(pages[1]!.words).toBe(30);
  });

  it('gives a code block a page of its own, never cut, with its introduction', () => {
    const code = ['```bash', ...Array.from({ length: 40 }, (_, i) => `echo line ${i}`), '```'].join('\n');
    const pages = paginateLesson(`${para(80)}\n\nRun this:\n\n${code}\n\n${para(80)}`);
    expect(shape(pages)).toEqual(['p', 'pc', 'p']);
    const block = pages[1]!.blocks[1]!;
    expect(block.type).toBe('code');
    expect(block.text!.split('\n')).toHaveLength(40);
  });

  it('a diagram right after a list or a heading has no paragraph to take: it goes alone (with the heading)', () => {
    expect(shape(paginateLesson(`- a\n- b\n\n::diagram[x]`))).toEqual(['l', 'd']);
    expect(shape(paginateLesson(`${para(10)}\n\n## The picture\n\n::diagram[x]\n\n${para(10)}`))).toEqual(['p', 'hd', 'p']);
  });

  it('two diagrams are two pages', () => {
    const pages = paginateLesson(`${para(20)}\n\n::diagram[a]\n\n${para(20)}\n\n::diagram[b]`);
    expect(shape(pages)).toEqual(['pd', 'pd']);
  });

  it('never ends a page on a heading', () => {
    const pages = paginateLesson(`${para(100)}\n\n### Then\n\n${para(100)}`);
    for (const p of pages) expect(p.blocks[p.blocks.length - 1]!.type).not.toBe('heading');
    expect(shape(pages)).toEqual(['p', 'hp']);
  });

  it('a ::page line is the author\'s own break, and draws nothing', () => {
    const pages = paginateLesson(`${para(10)}\n\n::page\n\n${para(10)}\n\n::page\n\n::page`);
    expect(shape(pages)).toEqual(['p', 'p']);
    expect(pages.flatMap((p) => p.blocks).some((b) => b.type === 'break')).toBe(false);
  });

  it('takes blocks as well as Markdown', () => {
    const src = `${para(20)}\n\n## Two\n\n${para(20)}`;
    expect(paginateLesson(md.parseMarkdown(src))).toEqual(paginateLesson(src));
  });

  it('honours maxWords', () => {
    expect(paginateLesson([para(30), para(30), para(30)].join('\n\n'), { maxWords: 40 })).toHaveLength(3);
  });
});

describe('clampPage', () => {
  it('keeps a page in range, else the first; "last" is the last', () => {
    expect(clampPage(2, 4)).toBe(2);
    expect(clampPage(4, 4)).toBe(0);
    expect(clampPage(-1, 4)).toBe(0);
    expect(clampPage('2', 4)).toBe(0);
    expect(clampPage('last', 4)).toBe(3);
    expect(clampPage('last', 0)).toBe(0);
  });
});

describe('the lessons of every lab, paged', () => {
  const root = join(__dirname, '../../labs');
  const lessons: Array<[string, string]> = [];
  for (const lab of readdirSync(root)) {
    const dir = join(root, lab, 'learn', 'concepts');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      lessons.push([`${lab}/${f}`, readFileSync(join(dir, f), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')]);
    }
  }

  it('finds lessons to check', () => {
    expect(lessons.length).toBeGreaterThan(10);
  });

  it.each(lessons)('%s: short pages, nothing lost, every diagram on its own page', (_name, body) => {
    const pages = paginateLesson(body);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.blocks)).toEqual(md.parseMarkdown(body).filter((b) => b.type !== 'break'));
    for (const p of pages) {
      // A page over the limit is one block (or one list with its introduction) that cannot be cut.
      if (p.words > PAGE_WORDS) expect(p.blocks.filter((b) => b.type !== 'heading').length).toBeLessThanOrEqual(2);
      expect(p.blocks.filter((b) => b.type === 'diagram' || b.type === 'code').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('the pager and its action bar (learn-lessons.js, learn.css)', () => {
  const src = (file: string) => readFileSync(new URL(`../../dashboard/${file}`, import.meta.url), 'utf8');
  const css = src('public/learn.css');

  it('renders the lesson diagrams without controls: they play by themselves', () => {
    expect(src('src/learn-lessons.js')).toMatch(/renderMarkdownNodes\(.*diagramOptions:\s*\{\s*controls:\s*false\s*\}/);
  });

  it('keeps the page clear of the sticky bar: a diagram fits above it, the screen scrolls clear of it, a phone un-sticks it', () => {
    // The diagram sits under the text and is drawn within the height left above the bar (at most 22rem; the column, the card's head and the bar take 40rem), from 761px up.
    expect(css).toMatch(/@media \(min-width: 761px\) \{\s*\.learn-wrap-lessons \.lesson-body \.diagram-svg \{ max-height: min\(22rem, max\(12rem, calc\(100dvh - 40rem\)\)\); \}/);
    expect(css).not.toMatch(/\.learn-wrap-lessons \.lesson-body > \.md-diagram \{\s*grid-column: 2/);
    // The screen keeps no dead padding under the bar and scrolls clear of it.
    expect(css).toMatch(/\.learn-screen:has\(\.learn-wrap-lessons\) \{ padding-bottom: 16px; scroll-padding-bottom: 112px; \}/);
    // On a phone the bar is in the page.
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.learn-wrap-lessons \.learn-actions-sticky \{ position: static; \}/);
  });

  it('is one centred reading column: the step head, the lesson card and the bar share it, 780px wide', () => {
    expect(css).toMatch(/\.learn-wrap\.learn-wrap-lessons \{\s*max-width: 780px; width: 100%;/);
    // Next keeps the right-hand end of the bar, Previous the left, the tally between them.
    expect(css).toMatch(/\.lesson-nav-prev \{ grid-column: 1; justify-self: start; \}/);
    expect(css).toMatch(/\.lesson-nav-next, \.lesson-nav \.learn-start \{ grid-column: 3; grid-row: 1; justify-self: end; \}/);
  });

  it('makes the lesson title the screen heading, with no step title, no plan summary line and no subtitle', () => {
    const js = src('src/learn-lessons.js');
    expect(js).toMatch(/make\('h1', 'lesson-title', concept\.title\)/);
    expect(js).toContain("title.setAttribute('data-learn-heading', '')");
    const flow = src('src/before-you-begin.js');
    for (const gone of ['Lessons for this lab', 'You decide what to read', 'plan-summary', 'planSummary']) expect(flow).not.toContain(gone);
  });

  it('says why a lesson is folded, and words the two calls on a lesson the same way', async () => {
    const m = (await import('../../dashboard/src/learn-lessons.js' as string)) as { foldReason: (r: string | null) => string };
    expect(m.foldReason('known')).toBe('You answered the questions on this correctly, so here is the one-line summary.');
    expect(m.foldReason('skipped')).toBe('You chose to skip this lesson, so here is the one-line summary.');
    expect(m.foldReason('strong')).toBe('Your quiz says you know this area well, so here is the one-line summary.');
    expect(m.foldReason(null)).toBe('Here is the one-line summary of this lesson.');
    const js = src('src/learn-lessons.js');
    expect(js).toContain("button('Read the full lesson'");
    expect(js).toContain("button('Skip, I know this'");
    for (const old of ['Show me the lesson anyway', 'I know this, skip', 'folded to a recap']) expect(js).not.toContain(old);
  });

  it('scrolls the card on past the bar when its body would end under it (a no-op where the bar is not sticky)', () => {
    const js = src('src/learn-lessons.js');
    expect(js).toContain("getComputedStyle(bar).position !== 'sticky'");
    expect(js).toContain('requestAnimationFrame(reveal)');
  });
});
