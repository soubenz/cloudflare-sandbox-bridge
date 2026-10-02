import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Learner-facing copy never describes how the platform is built.
 *
 * A learner reads "Starting your lab", not "Claiming a container": nothing on the launcher, the quiz,
 * the pre-lab steps, the session (header, tabs, dock, boot dialog, notices, toasts, banners, end and ended
 * dialogs, result card), the sign-in page, the not-found page, the footer, or the public site may name the
 * machinery (containers, snapshots, Workers, Cloudflare, tokens, status or error codes ...). What a lab
 * teaches (a gateway, a model, a trace) is not machinery and stays.
 *
 * What is scanned, as the learner would meet it:
 *   - HTML: text and the attributes a person reads (title, aria-label, placeholder, alt, value, meta content).
 *     Comments, scripts, styles, ids, classes and links are not read.
 *   - JS/TS: string and template literals (never comments), when they read as prose: they contain a space,
 *     or are one capitalised word. Event names, selectors, ids and import paths are code, not copy.
 *   - CSS: `content: '...'` strings.
 * Not scanned: site/public/privacy.html, which discloses its processor on purpose (legal), and
 * everything under labs/ and src/ (lab content and the API; the owner decides those).
 *
 * A justified exception goes in learner-copy.allow.json with a reason. An entry that no longer matches
 * anything fails the test, so the list cannot go stale.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');

/** The one list of words. Matched case-insensitively, on word boundaries. */
export const FORBIDDEN: Array<{ name: string; pattern: string }> = [
  { name: 'container', pattern: 'containers?' },
  { name: 'snapshot', pattern: 'snapshots?' },
  { name: 'VM', pattern: 'VMs?|virtual machines?' },
  { name: 'sandbox', pattern: 'sandbox(?:es|ed|ing)?' },
  { name: 'Worker', pattern: 'workers?' },
  { name: 'Durable Object', pattern: 'durable objects?' },
  { name: 'Cloudflare', pattern: 'cloudflare' },
  { name: 'R2', pattern: 'R2' },
  { name: 'D1', pattern: 'D1' },
  { name: 'session token', pattern: 'session tokens?' },
  { name: 'upstream', pattern: 'upstream' },
  { name: 'WebSocket', pattern: 'web ?sockets?' },
  { name: 'API', pattern: 'API' },
  { name: 'capacity slot', pattern: 'slots?' },
  { name: 'service key', pattern: 'service (?:key|binding)' },
  { name: 'Docker / Firecracker / Wrangler', pattern: 'docker|firecracker|wrangler' },
  { name: 'close code (1006 ...)', pattern: '1006|closed \\(\\d+\\)' },
  { name: 'platform error code', pattern: 'terminal_[a-z_]+|[a-z]+_upstream_[a-z_]+' },
  { name: 'HTTP status', pattern: 'HTTP\\s*[1-5]\\d\\d|status code|[45]\\d\\d(?=: )' },
];

const FORBIDDEN_RE = FORBIDDEN.map((f) => ({ name: f.name, re: new RegExp(`(?<![A-Za-z0-9_])(?:${f.pattern})(?![A-Za-z0-9_])`, 'i') }));

// ------------------------------------------------------------------ what is learner-facing

const list = (dir: string, ext: RegExp, skip: (name: string) => boolean = () => false) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => ext.test(f) && !skip(f))
    .sort()
    .map((f) => `${dir}/${f}`);

const HTML_FILES = ['dashboard/public/index.html', ...list('site/public', /\.html$/, (f) => f === 'privacy.html')];
const JS_FILES = [...list('dashboard/src', /\.js$/), ...list('dashboard/public', /\.js$/), ...list('site/public', /\.js$/), ...list('site/src', /\.ts$/)];
const CSS_FILES = list('dashboard/public', /\.css$/);

interface Found {
  file: string;
  word: string;
  text: string;
}

// ------------------------------------------------------------------ extraction

const READ_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'value', 'content']);

/** The text a person reads in a piece of HTML: its text nodes, and the attributes above. */
export function htmlCopy(html: string): string[] {
  const out: string[] = [];
  const tokens = html.replace(/<!--[\s\S]*?-->/g, ' ').match(/<(script|style)\b[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/gi) ?? [];
  for (const t of tokens) {
    if (/^<(script|style)\b/i.test(t)) continue;
    if (t.startsWith('<')) {
      for (const m of t.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        if (READ_ATTRS.has(m[1]!.toLowerCase())) out.push(m[3] ?? m[4] ?? '');
      }
      continue;
    }
    out.push(t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
  }
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** A string that reads as words to a person, rather than as code (an event name, selector, id or path). */
export function isProse(s: string): boolean {
  if (!/[A-Za-z]{3}/.test(s)) return false;
  return /\s/.test(s.trim()) || /^[A-Z][a-z]+$/.test(s.trim());
}

/** Every string and template literal of a script, with comments left out. */
export function scriptStrings(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // A key is a name, not copy.
      if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) out.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      // One string, with each ${...} left as a gap, so "a ${x} container" is read whole.
      out.push(node.head.text + node.templateSpans.map((span) => `\u2026${span.literal.text}`).join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The copy a script holds: prose strings, and the text of any markup it builds. */
function scriptCopy(file: string, source: string): string[] {
  const out: string[] = [];
  for (const s of scriptStrings(file, source)) {
    if (/<[a-z!][^>]*>/i.test(s)) out.push(...htmlCopy(s));
    else if (isProse(s)) out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function cssCopy(source: string): string[] {
  const out: string[] = [];
  for (const m of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/content\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2]!);
  return out.filter((s) => /[A-Za-z]{3}/.test(s));
}

function copyOf(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  if (file.endsWith('.html')) return htmlCopy(source);
  if (file.endsWith('.css')) return cssCopy(source);
  return scriptCopy(file, source);
}

export function scan(texts: string[], file: string): Found[] {
  const found: Found[] = [];
  for (const text of texts) {
    for (const f of FORBIDDEN_RE) if (f.re.test(text)) found.push({ file, word: f.name, text });
  }
  return found;
}

// ------------------------------------------------------------------ the allowlist

interface Allow {
  file: string;
  includes: string;
  reason: string;
}
const ALLOW: Allow[] = (JSON.parse(readFileSync(join(here, 'learner-copy.allow.json'), 'utf8')) as { allow: Allow[] }).allow;

describe('learner-facing copy does not describe how the platform is built', () => {
  const all = [...HTML_FILES, ...JS_FILES, ...CSS_FILES].flatMap((file) => scan(copyOf(file), file));
  const used = new Set<Allow>();
  const offenders = all.filter((f) => {
    const hit = ALLOW.find((a) => a.file === f.file && f.text.includes(a.includes));
    if (hit) used.add(hit);
    return !hit;
  });

  it('scans the learner-facing files it says it does', () => {
    expect(HTML_FILES).toContain('dashboard/public/index.html');
    expect(HTML_FILES).not.toContain('site/public/privacy.html');
    expect(HTML_FILES.filter((f) => f.startsWith('site/public/')).length).toBeGreaterThanOrEqual(5);
    expect(JS_FILES).toEqual(expect.arrayContaining(['dashboard/src/app.js', 'dashboard/src/worker.js', 'dashboard/src/terminal.js', 'dashboard/public/login.js', 'site/src/worker.ts']));
    expect(CSS_FILES).toContain('dashboard/public/styles.css');
  });

  it('finds the words it forbids (the scanner is not blind)', () => {
    const sample = htmlCopy('<p title="A snapshot">Claiming a <b>container</b>…</p><!-- a container --><script>container</script>');
    expect(scan(sample, 'x.html').map((f) => f.word).sort()).toEqual(['container', 'snapshot']);
    expect(scriptCopy('x.js', "// a container\nconst a = 'Terminal closed (1006)'; const b = 'container.restarted'; const c = `Claiming a ${x} container`;").length).toBe(2);
    expect(scan(['The terminal closed (1006)'], 'x.js')[0]?.word).toBe('close code (1006 ...)');
    expect(scan(['Something went wrong: 502: bad'], 'x.js')[0]?.word).toBe('HTTP status');
    expect(scan(['Containerised or snapshotting'], 'x.js')).toEqual([]);
  });

  it('has no forbidden word in anything a learner reads', () => {
    const lines = offenders.map((o) => `  ${o.file}  [${o.word}]  ${JSON.stringify(o.text.length > 140 ? `${o.text.slice(0, 140)}…` : o.text)}`);
    expect(lines, `Rewrite the copy (what it means for the learner, what to do next), or justify it in test/unit/learner-copy.allow.json:\n${lines.join('\n')}\n`).toEqual([]);
  });

  it('keeps every allowlist entry real: a file that is scanned, a phrase that is still there, a reason given', () => {
    const scanned = new Set([...HTML_FILES, ...JS_FILES, ...CSS_FILES]);
    const problems: string[] = [];
    for (const a of ALLOW) {
      if (!scanned.has(a.file)) problems.push(`${a.file} is not a scanned file (privacy.html is excluded as a whole)`);
      if (!a.reason || a.reason.trim().length < 20) problems.push(`${a.file} "${a.includes}" has no real reason`);
      if (!used.has(a)) problems.push(`${a.file} "${a.includes}" matches nothing any more: remove it`);
    }
    expect(problems).toEqual([]);
  });
});
