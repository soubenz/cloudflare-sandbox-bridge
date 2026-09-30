/**
 * The safe Markdown subset of the learning content (story and lessons),
 * drawn straight into DOM nodes.
 *
 * Two halves, like diagram.js: parseMarkdown / parseInline are pure (text in,
 * a small tree of plain objects out) and the unit tests read them directly;
 * renderMarkdownNodes builds elements from that tree.
 *
 * Nothing here ever writes markup. Elements come from createElement, every
 * string from the content goes in as a text node or an attribute value, and
 * the only attribute taken from the content is an http(s) link's href. The
 * bundle schema already refuses `<` followed by a letter (src/labs/learn.ts),
 * but this renderer does not rely on that: text that looks like a tag is just
 * text here.
 *
 * Supported: paragraphs, `##` and `###` headings, **bold**, *italic*,
 * `code`, fenced code blocks, `- ` lists, `1. ` lists, `[text](https://...)`
 * links (http and https only, opened with rel="noopener noreferrer"), and a
 * line `::diagram[id]` that mounts the diagram player from the shared
 * library (packages/catalogue/diagrams.json).
 */

import { renderDiagram as defaultRenderDiagram } from './diagram.js';
import library from '../../packages/catalogue/diagrams.json';

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** http and https only, and it has to parse: `javascript:`, `data:` and the rest are refused. */
export function safeHref(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Deepest nesting of bold/italic/link inside each other that is still parsed. */
const MAX_DEPTH = 4;

/**
 * Inline text to a list of nodes:
 *   { type: 'text', text } | { type: 'code', text } | { type: 'strong' | 'em', children }
 *   | { type: 'link', href, children }
 * An opening marker with no closing one is plain text. A link whose target is
 * not http(s) keeps its label and drops the link.
 */
export function parseInline(src, depth = 0) {
  const s = String(src ?? '');
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === '*' && s[i + 1] === '*' && depth < MAX_DEPTH) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    } else if (ch === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && depth < MAX_DEPTH) {
      // The closing star is the next one that is not half of a `**`.
      let end = i + 1;
      while (end < s.length && !(s[end] === '*' && s[end + 1] !== '*' && s[end - 1] !== '*')) end++;
      if (end < s.length && end > i + 1 && s[end - 1] !== ' ') {
        flush();
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    } else if (ch === '[' && depth < MAX_DEPTH) {
      const close = s.indexOf('](', i + 1);
      // The target ends at the parenthesis that balances the one after `]`, so
      // `(https://a.test/x_(y))` and `(javascript:alert(1))` each end where they should.
      let paren = -1;
      if (close > i) {
        let depth = 1;
        for (let j = close + 2; j < s.length; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')' && --depth === 0) {
            paren = j;
            break;
          }
        }
      }
      if (close > i + 1 && paren > close) {
        const label = s.slice(i + 1, close);
        const href = safeHref(s.slice(close + 2, paren));
        flush();
        const children = parseInline(label, depth + 1);
        if (href) out.push({ type: 'link', href, children });
        else out.push(...children);
        i = paren + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const DIAGRAM_LINE = /^::diagram\[([^\]\s]*)\]\s*$/;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const BULLET = /^\s*-\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;

/**
 * Markdown to blocks:
 *   { type: 'heading', level: 2 | 3, inline } | { type: 'paragraph', inline }
 *   | { type: 'code', text, lang } | { type: 'list', ordered, items: inline[] }
 *   | { type: 'diagram', id }
 * `level` is relative: 2 is a `##` (or `#`), 3 is a `###` or deeper.
 */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  let item = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
  };
  const flushItem = () => {
    if (item !== null && list) list.items.push(parseInline(item));
    item = null;
  };
  const closeList = () => {
    flushItem();
    if (list) blocks.push(list);
    list = null;
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trimEnd();

    const fence = line.match(FENCE);
    if (fence) {
      flushPara();
      closeList();
      const body = [];
      n++;
      while (n < lines.length && !FENCE.test(lines[n].trimEnd())) body.push(lines[n++]);
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[1] || '' });
      continue;
    }

    const diagram = line.match(DIAGRAM_LINE);
    if (diagram) {
      flushPara();
      closeList();
      blocks.push({ type: 'diagram', id: diagram[1] });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushPara();
      closeList();
      blocks.push({ type: 'heading', level: heading[1].length <= 2 ? 2 : 3, inline: parseInline(heading[2]) });
      continue;
    }

    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) closeList();
      else flushItem();
      if (!list) list = { type: 'list', ordered, items: [] };
      item = (bullet ?? numbered)[1];
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    // An indented line straight after a list item is that item wrapping.
    if (item !== null && /^\s+\S/.test(raw)) {
      item += ` ${line.trim()}`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return blocks;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/** Appends parsed inline nodes to `parent`: text nodes, code, strong, em and (safe) links. */
function inlineInto(doc, parent, nodes) {
  for (const n of nodes) {
    if (n.type === 'text') {
      parent.appendChild(doc.createTextNode(n.text));
    } else if (n.type === 'code') {
      const c = doc.createElement('code');
      c.textContent = n.text;
      parent.appendChild(c);
    } else {
      const e = doc.createElement(n.type === 'strong' ? 'strong' : n.type === 'em' ? 'em' : 'a');
      if (n.type === 'link') {
        e.setAttribute('href', n.href);
        e.setAttribute('target', '_blank');
        e.setAttribute('rel', 'noopener noreferrer');
      }
      inlineInto(doc, e, n.children);
      parent.appendChild(e);
    }
  }
}

/** The diagrams the console knows, by id. */
export const DIAGRAMS = new Map((library.diagrams || []).map((d) => [d.id, d]));

/**
 * Renders `src` into DOM nodes.
 *
 *   document       the document to build in (default: the page's)
 *   headingLevel   the tag level of a `##` (default 3, so a lesson under an
 *                  h2 keeps the outline unbroken); `###` is one deeper
 *   diagrams       Map or array of diagrams (default: the shared library)
 *   renderDiagram  the player factory (default: diagram.js's)
 *   diagramOptions options handed to each player
 *
 * Returns { nodes, players, destroy }: append `nodes` where they belong;
 * `destroy()` stops every diagram player the render created (call it when
 * the content leaves the page). A `::diagram[id]` that names nothing in the
 * library, or whose player throws, becomes a small notice, never an error.
 */
export function renderMarkdownNodes(src, opts = {}) {
  const doc = opts.document || document;
  const base = Math.min(5, Math.max(1, Number(opts.headingLevel) || 3));
  const diagrams = opts.diagrams instanceof Map ? opts.diagrams : Array.isArray(opts.diagrams) ? new Map(opts.diagrams.map((d) => [d.id, d])) : DIAGRAMS;
  const makePlayer = opts.renderDiagram || defaultRenderDiagram;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute('class', cls);
    if (text != null) e.textContent = text;
    return e;
  };
  const nodes = [];
  const players = [];
  for (const block of parseMarkdown(src)) {
    if (block.type === 'heading') {
      const h = el(`h${Math.min(6, base + (block.level - 2))}`);
      inlineInto(doc, h, block.inline);
      nodes.push(h);
    } else if (block.type === 'paragraph') {
      const p = el('p');
      inlineInto(doc, p, block.inline);
      nodes.push(p);
    } else if (block.type === 'code') {
      const pre = el('pre');
      const code = el('code', '', block.text);
      pre.appendChild(code);
      nodes.push(pre);
    } else if (block.type === 'list') {
      const list = el(block.ordered ? 'ol' : 'ul');
      for (const inline of block.items) {
        const li = el('li');
        inlineInto(doc, li, inline);
        list.appendChild(li);
      }
      nodes.push(list);
    } else if (block.type === 'diagram') {
      const slot = el('div', 'md-diagram');
      slot.setAttribute('data-diagram-id', block.id);
      const diagram = diagrams.get(block.id);
      let player = null;
      if (diagram) {
        try {
          player = makePlayer(diagram, { document: doc, ...(opts.diagramOptions || {}) });
        } catch {
          player = null;
        }
      }
      if (player) {
        slot.appendChild(player);
        players.push(player);
      } else {
        slot.setAttribute('class', 'md-diagram md-diagram-missing');
        slot.setAttribute('role', 'note');
        slot.textContent = block.id ? `The diagram "${block.id}" is not available.` : 'A diagram is not available.';
      }
      nodes.push(slot);
    }
  }

  return {
    nodes,
    players,
    destroy() {
      for (const p of players.splice(0)) {
        try {
          p.destroy?.();
        } catch {
          /* a player that cannot stop is already gone */
        }
      }
    },
  };
}

/**
 * Inline Markdown (code, bold, italic, links) into `parent`, for one-line text
 * such as a question's prompt. Appends text nodes and elements only.
 */
export function appendInline(parent, text, opts = {}) {
  inlineInto(opts.document || document, parent, parseInline(text));
  return parent;
}

/** Renders `src` and appends the result to `parent`; returns { players, destroy }. */
export function mountMarkdown(parent, src, opts = {}) {
  const r = renderMarkdownNodes(src, opts);
  for (const n of r.nodes) parent.appendChild(n);
  return { players: r.players, destroy: r.destroy };
}
