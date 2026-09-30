import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIAGRAMS as LIBRARY } from '../../src/labs/diagram';

/**
 * The safe Markdown subset of the learning content, drawn as DOM nodes.
 * Parsing is pure and tested directly. The DOM half runs against a small
 * stand-in for `document` (no jsdom in this repo) that exposes only what the
 * renderer is allowed to use: createElement, createTextNode, setAttribute,
 * appendChild and textContent. Setting innerHTML (or any other markup entry
 * point) throws, so a renderer that reached for it would fail here.
 */
type Inline = { type: string; text?: string; href?: string; children?: Inline[] };
type Block = { type: string; level?: number; inline?: Inline[]; text?: string; lang?: string; ordered?: boolean; items?: Inline[][]; id?: string };
const mod = (await import('../../dashboard/src/markdown.js' as string)) as {
  parseMarkdown: (s: string) => Block[];
  parseInline: (s: string) => Inline[];
  safeHref: (s: string) => string | null;
  renderMarkdownNodes: (s: string, o?: Record<string, unknown>) => { nodes: FakeNode[]; players: FakeNode[]; destroy: () => void };
  mountMarkdown: (p: FakeEl, s: string, o?: Record<string, unknown>) => { players: FakeNode[]; destroy: () => void };
  appendInline: (p: FakeEl, s: string, o?: Record<string, unknown>) => FakeEl;
  DIAGRAMS: Map<string, unknown>;
};
const { parseMarkdown, parseInline, safeHref, renderMarkdownNodes, mountMarkdown, appendInline, DIAGRAMS } = mod;

// ------------------------------------------------------------------ fake DOM

class FakeText {
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}
class FakeEl {
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  appendChild<T extends FakeNode>(c: T): T {
    this.children.push(c);
    return c;
  }
  set textContent(v: string) {
    this.children = v === '' ? [] : [new FakeText(String(v))];
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must not be used');
  }
  set outerHTML(_v: string) {
    throw new Error('outerHTML must not be used');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML must not be used');
  }
}
type FakeNode = FakeEl | FakeText;
const fakeDoc = () => ({
  createElement: (tag: string) => new FakeEl(tag),
  createTextNode: (s: string) => new FakeText(s),
});

const tagOf = (n: FakeNode) => (n instanceof FakeEl ? n.tag : '#text');
const kids = (n: FakeNode) => (n instanceof FakeEl ? n.children : []);
const find = (n: FakeNode, tag: string): FakeEl[] => [...(n instanceof FakeEl && n.tag === tag ? [n] : []), ...kids(n).flatMap((c) => find(c, tag))];
const render = (src: string, o: Record<string, unknown> = {}) => renderMarkdownNodes(src, { document: fakeDoc(), ...o });

// -------------------------------------------------------------------- inline

describe('inline markdown', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** and *c* and `d`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'c' }] },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'd' },
    ]);
  });

  it('keeps markers inside code literal', () => {
    expect(parseInline('`a **b** *c*`')).toEqual([{ type: 'code', text: 'a **b** *c*' }]);
  });

  it('nests italic in bold and bold in italic', () => {
    expect(parseInline('**a *b* c**')[0]).toEqual({
      type: 'strong',
      children: [{ type: 'text', text: 'a ' }, { type: 'em', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' c' }],
    });
    expect(parseInline('*a **b** c*')[0]!.type).toBe('em');
  });

  it('leaves an unclosed marker as text', () => {
    expect(parseInline('**open')).toEqual([{ type: 'text', text: '**open' }]);
    expect(parseInline('a `open')).toEqual([{ type: 'text', text: 'a `open' }]);
    expect(parseInline('*open')).toEqual([{ type: 'text', text: '*open' }]);
    expect(parseInline('3 * 4 * 5')).toEqual([{ type: 'text', text: '3 * 4 * 5' }]);
  });

  it('makes a link only for http and https', () => {
    expect(parseInline('[docs](https://example.com/a?b=1)')).toEqual([{ type: 'link', href: 'https://example.com/a?b=1', children: [{ type: 'text', text: 'docs' }] }]);
    expect(parseInline('[docs](http://example.com)')[0]).toMatchObject({ type: 'link', href: 'http://example.com/' });
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.test', '/relative', 'ftp://x.test', 'https:/x', 'mailto:a@b.c']) {
      const out = parseInline(`[click](${bad})`);
      expect(out, bad).toEqual([{ type: 'text', text: 'click' }]);
    }
  });

  it('ends a link target at its balancing parenthesis', () => {
    expect(parseInline('[w](https://a.test/x_(y)) z')).toEqual([
      { type: 'link', href: 'https://a.test/x_(y)', children: [{ type: 'text', text: 'w' }] },
      { type: 'text', text: ' z' },
    ]);
    expect(parseInline('[w](javascript:alert(1)) z')).toEqual([
      { type: 'text', text: 'w' },
      { type: 'text', text: ' z' },
    ]);
  });

  it('refuses hrefs with spaces or control characters', () => {
    expect(safeHref('https://a.test/x y')).toBeNull();
    expect(safeHref('https://a.test/\u0000')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(undefined as unknown as string)).toBeNull();
    expect(safeHref('https://a.test')).toBe('https://a.test/');
  });

  it('stops nesting at a fixed depth instead of recursing without end', () => {
    const deep = '**'.repeat(1).concat('*a'.repeat(50));
    expect(() => parseInline(deep + ' x'.repeat(10))).not.toThrow();
    const nested = '['.repeat(200) + 'x' + '](https://a.test)'.repeat(1);
    expect(() => parseInline(nested)).not.toThrow();
  });
});

// -------------------------------------------------------------------- blocks

describe('block markdown', () => {
  it('joins the lines of a paragraph and splits on blank lines', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', text: 'one two' }] },
      { type: 'paragraph', inline: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('reads ## and ### headings (and # as ##, deeper as ###)', () => {
    const blocks = parseMarkdown('# One\n## Two\n### Three\n#### Four\n#nospace');
    expect(blocks.map((b) => [b.type, b.level])).toEqual([
      ['heading', 2],
      ['heading', 2],
      ['heading', 3],
      ['heading', 3],
      ['paragraph', undefined],
    ]);
  });

  it('reads bullet and numbered lists, wrapped items included', () => {
    const blocks = parseMarkdown('- a\n- b\n  wraps\n\n1. one\n2. two');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[0]!.items).toEqual([[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b wraps' }]]);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true });
    expect(blocks[1]!.items).toHaveLength(2);
  });

  it('switches list kind without merging them', () => {
    const blocks = parseMarkdown('- a\n1. b');
    expect(blocks.map((b) => [b.type, b.ordered])).toEqual([
      ['list', false],
      ['list', true],
    ]);
  });

  it('keeps a fenced block literal, including what looks like markdown', () => {
    const blocks = parseMarkdown('```yaml\n# not a heading\n- not: a list\n**not bold**\n```\nafter');
    expect(blocks[0]).toEqual({ type: 'code', text: '# not a heading\n- not: a list\n**not bold**', lang: 'yaml' });
    expect(blocks[1]).toMatchObject({ type: 'paragraph' });
  });

  it('treats an unterminated fence as running to the end', () => {
    expect(parseMarkdown('```\nx\ny')).toEqual([{ type: 'code', text: 'x\ny', lang: '' }]);
  });

  it('reads ::diagram[id] alone on a line, and only there', () => {
    expect(parseMarkdown('text\n::diagram[gateway-alias-routing]\nmore')).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', text: 'text' }] },
      { type: 'diagram', id: 'gateway-alias-routing' },
      { type: 'paragraph', inline: [{ type: 'text', text: 'more' }] },
    ]);
    expect(parseMarkdown('see ::diagram[x] here')[0]!.type).toBe('paragraph');
  });

  it('does not read a diagram line inside a fence', () => {
    expect(parseMarkdown('```\n::diagram[x]\n```')).toEqual([{ type: 'code', text: '::diagram[x]', lang: '' }]);
  });

  it('handles CRLF and empty input', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2);
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(undefined as unknown as string)).toEqual([]);
  });
});

// ----------------------------------------------------------------------- DOM

describe('rendering to DOM nodes', () => {
  it('builds headings at the requested level, paragraphs, lists and code', () => {
    const { nodes } = render('## Title\n\nText with **bold**, *em* and `code`.\n\n- a\n- b\n\n1. x\n\n```\nlet x = 1 < 2\n```\n\n### Sub', { headingLevel: 3 });
    expect(nodes.map(tagOf)).toEqual(['h3', 'p', 'ul', 'ol', 'pre', 'h4']);
    const p = nodes[1] as FakeEl;
    expect(p.children.map(tagOf)).toEqual(['#text', 'strong', '#text', 'em', '#text', 'code', '#text']);
    expect(p.textContent).toBe('Text with bold, em and code.');
    expect(find(nodes[2]!, 'li')).toHaveLength(2);
    expect(nodes[4]!.textContent).toBe('let x = 1 < 2');
  });

  it('defaults to h3 for a ##', () => {
    expect(tagOf(render('## Hi').nodes[0]!)).toBe('h3');
  });

  it('turns text that looks like markup into text, never into elements', () => {
    const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> &lt;b&gt;\n\n`<b>x</b>`\n\n- <iframe src="https://x.test"></iframe>';
    const { nodes } = render(hostile);
    for (const tag of ['script', 'img', 'iframe', 'b']) expect(nodes.flatMap((n) => find(n, tag)), tag).toEqual([]);
    expect(nodes[0]!.textContent).toContain('<script>alert(1)</script>');
    expect(find(nodes[1]!, 'code')[0]!.textContent).toBe('<b>x</b>');
  });

  it('sets href, target and rel on a link, and nothing else from the content', () => {
    const { nodes } = render('[a](https://example.com/x) and [b](javascript:alert(1)) and [c](http://example.com)');
    const links = find(nodes[0]!, 'a');
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect([...a.attrs.keys()].sort()).toEqual(['href', 'rel', 'target']);
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
    }
    expect(nodes[0]!.textContent).toBe('a and b and c');
  });

  it('never sets an attribute from a diagram id or a language tag', () => {
    const { nodes } = render('```"><script>\nx\n```\n\n::diagram[x" onload="alert(1)]');
    const all = (n: FakeNode): FakeEl[] => (n instanceof FakeEl ? [n, ...n.children.flatMap(all)] : []);
    for (const el of nodes.flatMap(all)) {
      for (const [k, v] of el.attrs) {
        if (k === 'data-diagram-id') continue;
        expect(v).not.toContain('onload');
      }
    }
    expect(nodes.flatMap(all).some((e) => [...e.attrs.keys()].some((k) => k.startsWith('on')))).toBe(false);
  });

  it('mounts the player for a known diagram and keeps it for destroy()', () => {
    const player = new FakeEl('div') as FakeEl & { destroy?: () => void };
    player.destroy = vi.fn();
    const make = vi.fn(() => player);
    const r = render('before\n\n::diagram[gateway-alias-routing]\n\nafter', { renderDiagram: make });
    expect(make).toHaveBeenCalledTimes(1);
    expect((make.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 'gateway-alias-routing' });
    expect(r.nodes.map(tagOf)).toEqual(['p', 'div', 'p']);
    expect((r.nodes[1] as FakeEl).children[0]).toBe(player);
    expect(r.players).toEqual([player]);
    r.destroy();
    expect(player.destroy).toHaveBeenCalledTimes(1);
    r.destroy();
    expect(player.destroy).toHaveBeenCalledTimes(1);
  });

  it('renders a small notice for an unknown diagram, not a crash', () => {
    const make = vi.fn();
    const r = render('::diagram[nope-not-there]', { renderDiagram: make });
    expect(make).not.toHaveBeenCalled();
    const slot = r.nodes[0] as FakeEl;
    expect(slot.getAttribute('class')).toContain('md-diagram-missing');
    expect(slot.getAttribute('role')).toBe('note');
    expect(slot.textContent).toContain('nope-not-there');
    expect(r.players).toEqual([]);
    expect(() => render('::diagram[]')).not.toThrow();
  });

  it('turns a player that throws into the same notice', () => {
    const r = render('::diagram[gateway-alias-routing]', {
      renderDiagram: () => {
        throw new Error('broken');
      },
    });
    expect((r.nodes[0] as FakeEl).getAttribute('class')).toContain('md-diagram-missing');
  });

  it('knows every diagram in the shared library', () => {
    expect(DIAGRAMS.size).toBe(LIBRARY.length);
    for (const d of LIBRARY) expect(DIAGRAMS.has(d.id)).toBe(true);
  });

  it('accepts a list of diagrams in place of the library', () => {
    const make = vi.fn(() => new FakeEl('div'));
    render('::diagram[mine]', { diagrams: [{ id: 'mine' }], renderDiagram: make });
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('mountMarkdown appends to a parent, and appendInline handles one line', () => {
    const parent = new FakeEl('section');
    const m = mountMarkdown(parent, 'One\n\nTwo', { document: fakeDoc() });
    expect(parent.children.map(tagOf)).toEqual(['p', 'p']);
    expect(m.players).toEqual([]);
    const line = appendInline(new FakeEl('p'), 'Which `support` alias? **Now**', { document: fakeDoc() });
    expect(line.children.map(tagOf)).toEqual(['#text', 'code', '#text', 'strong']);
  });

  it('does not use any markup-writing API in its source', () => {
    const src = readFileSync('dashboard/src/markdown.js', 'utf8');
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
  });
});
