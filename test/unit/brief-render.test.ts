import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The brief renderer turns lab-authored Markdown into console HTML.
 *
 * Lab content comes from a published bundle rather than from us, so the
 * escaping matters as much as the formatting: a brief is the one place a
 * lab author's text is injected into the console's own DOM.
 *
 * Loaded out of the bundle source rather than imported, because app.js is a
 * browser module that touches `document` at load time.
 */
function loadRenderer(): (src: string) => string {
  const src = readFileSync('dashboard/src/app.js', 'utf8');
  const start = src.indexOf('export function renderMarkdown');
  const end = src.indexOf('\n}', src.indexOf('return html.join', start)) + 2;
  const body = src.slice(start, end).replace('export function', 'return function');
  return new Function(`${body}\nreturn renderMarkdown;`)() as (src: string) => string;
}

const render = loadRenderer();

describe('brief rendering', () => {
  it('renders headings, lists, code fences and tables', () => {
    const html = render(
      ['# Title', '', 'Some **bold** and `code`.', '', '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```bash', 'echo hi', '```'].join('\n')
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<pre><code>echo hi</code></pre>');
    // The alignment row is structure, not content.
    expect(html).not.toContain('---');
  });

  it('leaves no raw Markdown in the output', () => {
    const html = render(['| a | b |', '|---|---|', '| 1 | 2 |', '', '**bold**'].join('\n'));
    expect(html).not.toMatch(/\|/);
    expect(html).not.toMatch(/\*\*/);
  });

  it('escapes author markup rather than trusting it', () => {
    const html = render('# <img src=x onerror=alert(1)>\n\n`<script>bad()</script>`\n\n| <b>x</b> | y |');
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain('&lt;img');
  });

  it('does not treat markup inside a code fence as markup', () => {
    const html = render('```\n# not a heading\n- not a list\n```');
    expect(html).toContain('# not a heading');
    expect(html).not.toContain('<h2>');
    expect(html).not.toContain('<li>');
  });

  it('renders every shipped fixture brief without leaking syntax', () => {
    for (const slug of ['hello', 'gateway-hello', 'fragile', 'impatient']) {
      const html = render(readFileSync(`test/fixtures/labs/${slug}/brief.md`, 'utf8'));
      expect(html, slug).toContain('<h2>');
      // A pipe surviving means a table row was rendered as a paragraph.
      expect(html.replace(/<[^>]+>/g, ''), slug).not.toMatch(/\|/);
      expect(html, slug).not.toMatch(/<script|onerror=/i);
    }
  });
});
