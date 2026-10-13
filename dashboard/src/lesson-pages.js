/**
 * A lesson cut into short pages, so a learner reads one screenful at a time
 * (the pager in learn-lessons.js draws them). Pure: Markdown (or the blocks of
 * markdown.js's parseMarkdown) in, a list of pages of blocks out.
 *
 * The rules, in order:
 *   - a `##` heading starts a new page, and so does a line `::page` (the
 *     author's own break; it draws nothing)
 *   - a part longer than `maxWords` (about 120) is cut further, at block
 *     boundaries only, into pages of as even a length as can be had
 *   - a list is never cut, and a paragraph that ends in ":" (or a bold line on
 *     its own, standing in for a heading) stays with what it introduces, unless
 *     the two together are longer than a page
 *   - a diagram or a code block gets a page of its own, with the paragraph
 *     just before it (its introduction) and any heading above that
 *   - a heading is never the last thing on a page
 *
 * Each page is { blocks, words, visual }: `words` counts the words of its text,
 * `visual` says it holds a diagram or a code block. A lesson with no text still
 * has one (empty) page.
 */

import { parseMarkdown } from './markdown.js';

/** About this many words to a page. */
export const PAGE_WORDS = 120;

/** The plain text of parsed inline nodes. */
function inlineText(nodes) {
  let out = '';
  for (const n of nodes || []) out += n.text != null ? n.text : inlineText(n.children);
  return out;
}

const wordsIn = (text) => (String(text).match(/\S+/g) || []).length;

/** The words a block puts on the page. A diagram has none; a code block counts its lines. */
export function blockWords(block) {
  if (block.type === 'heading' || block.type === 'paragraph') return wordsIn(inlineText(block.inline));
  if (block.type === 'list') return block.items.reduce((n, item) => n + wordsIn(inlineText(item)), 0);
  if (block.type === 'code') return String(block.text || '').split('\n').length * 4;
  return 0;
}

const isVisual = (b) => b.type === 'diagram' || b.type === 'code';
/** A paragraph that leads into what follows: one ending in ":", or a bold line standing in for a heading. */
const leadsIn = (b) =>
  b.type === 'paragraph' && (/:\s*$/.test(inlineText(b.inline)) || (b.inline.length === 1 && b.inline[0].type === 'strong'));

/**
 * Splits `units` (each { blocks, words }, none longer than `max`) into the fewest
 * runs whose longest is no more than `max`, and among those the most even.
 * Contiguous; the order is kept.
 */
function balance(units, max) {
  const n = units.length;
  if (n === 0) return [];
  const total = units.reduce((s, u) => s + u.words, 0);
  const prefix = [0];
  for (const u of units) prefix.push(prefix[prefix.length - 1] + u.words);
  const sum = (a, b) => prefix[b] - prefix[a];
  // best[k][i]: the smallest possible longest run when the first i units make k runs.
  for (let k = Math.max(1, Math.ceil(total / max)); k <= n; k++) {
    const best = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
    const cut = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
    best[0][0] = 0;
    for (let r = 1; r <= k; r++) {
      for (let i = r; i <= n; i++) {
        for (let j = r - 1; j < i; j++) {
          const v = Math.max(best[r - 1][j], sum(j, i));
          if (v < best[r][i]) {
            best[r][i] = v;
            cut[r][i] = j;
          }
        }
      }
    }
    if (best[k][n] > max) continue;
    const runs = [];
    let i = n;
    for (let r = k; r >= 1; r--) {
      const j = cut[r][i];
      runs.unshift(units.slice(j, i));
      i = j;
    }
    return runs;
  }
  return units.map((u) => [u]);
}

/**
 * The pages of a lesson.
 *
 *   source    the lesson's Markdown body, or the blocks parseMarkdown made of it
 *   maxWords  about how many words a page holds (default PAGE_WORDS)
 *
 * Returns [{ blocks, words, visual }], never empty.
 */
export function paginateLesson(source, { maxWords = PAGE_WORDS } = {}) {
  const blocks = Array.isArray(source) ? source : parseMarkdown(source);

  // 1. Parts: a `##` heading or a `::page` line starts the next one.
  const parts = [[]];
  for (const b of blocks) {
    if (b.type === 'break') {
      if (parts[parts.length - 1].length) parts.push([]);
      continue;
    }
    if (b.type === 'heading' && b.level === 2 && parts[parts.length - 1].length) parts.push([]);
    parts[parts.length - 1].push(b);
  }

  const pages = [];
  for (const part of parts) {
    if (!part.length) continue;

    // 2. Units: what must stay together. A heading holds on to what follows it, a
    //    paragraph ending in ":" to what it introduces, and a diagram or code block takes the
    //    paragraph before it (with its heading) and is then a page of its own.
    const units = [];
    let held = [];
    for (let i = 0; i < part.length; i++) {
      const b = part[i];
      if (b.type === 'heading') {
        held.push(b);
        continue;
      }
      if (isVisual(b)) {
        const prev = units[units.length - 1];
        let lead = [];
        if (!held.length && prev && !prev.visual && prev.blocks[prev.blocks.length - 1].type === 'paragraph' && prev.blocks.every((x) => x.type === 'heading' || x.type === 'paragraph')) {
          // The introduction comes along, with a heading it carried; anything earlier in the unit stays put.
          const at = prev.blocks.length - 1;
          let from = at;
          while (from > 0 && prev.blocks[from - 1].type === 'heading') from--;
          lead = prev.blocks.slice(from);
          prev.blocks = prev.blocks.slice(0, from);
          if (!prev.blocks.length) units.pop();
        }
        const own = [...lead, ...held, b];
        held = [];
        units.push({ blocks: own, visual: true });
        continue;
      }
      const unit = { blocks: [...held, b], visual: false };
      held = [];
      // "...these steps:" (or a bold line on its own) and the list or text it leads into.
      while (leadsIn(unit.blocks[unit.blocks.length - 1]) && i + 1 < part.length && !isVisual(part[i + 1]) && part[i + 1].type !== 'heading') {
        unit.blocks.push(part[++i]);
      }
      // Together they would be more than a page: then each goes on its own (a list is still never cut).
      const words = unit.blocks.reduce((n, x) => n + blockWords(x), 0);
      const text = unit.blocks.filter((x) => x.type !== 'heading');
      if (text.length > 1 && words > maxWords) {
        const heads = unit.blocks.filter((x) => x.type === 'heading');
        text.forEach((x, k) => units.push({ blocks: k === 0 ? [...heads, x] : [x], visual: false }));
      } else units.push(unit);
    }
    // A heading with nothing after it in this part still goes on a page.
    if (held.length) units.push({ blocks: held, visual: false });
    for (const u of units) u.words = u.blocks.reduce((n, b) => n + blockWords(b), 0);

    // 3. Pages: each visual unit alone, the text between them cut as evenly as it goes.
    //    A unit longer than a page cannot be cut: it is a page alone, and does not stretch the others.
    let run = [];
    const flush = () => {
      let even = [];
      const settle = () => {
        for (const r of balance(even, maxWords)) pages.push(r.flatMap((u) => u.blocks));
        even = [];
      };
      for (const u of run) {
        if (u.words > maxWords) {
          settle();
          pages.push(u.blocks);
        } else even.push(u);
      }
      settle();
      run = [];
    };
    for (const u of units) {
      if (u.visual) {
        flush();
        pages.push(u.blocks);
      } else run.push(u);
    }
    flush();
  }

  const out = pages.map((p) => ({ blocks: p, words: p.reduce((n, b) => n + blockWords(b), 0), visual: p.some(isVisual) }));
  return out.length ? out : [{ blocks: [], words: 0, visual: false }];
}

/** The page to open on: `n` when it is a page of `count`, else the first (or the last, for 'last'). */
export function clampPage(n, count) {
  if (n === 'last') return Math.max(0, count - 1);
  return Number.isInteger(n) && n >= 0 && n < count ? n : 0;
}
