#!/usr/bin/env node
// Builds the public "every lab" page, site/public/labs.html, from the lab
// manifests and the catalogue copy.
//
//   node scripts/build-labs-page.mjs           write site/public/labs.html
//   node scripts/build-labs-page.mjs --check   exit 1 if the committed file
//                                              differs from a fresh render
//
// The site has no build step, so the generated page is committed; --check (and
// test/unit/build-labs-page.test.ts) catch a manifest or copy change that was
// not followed by a rebuild.
//
// Two sources. The labs (title, summary, type, time, tier, order) come from
// labs/*/manifest.yaml; a lab is listed when its manifest has a `path` field,
// so the fixture labs (hello, fragile, impatient, gateway-hello,
// gateway-litellm-hello) and labs without a catalogue slot are skipped. The
// words about each path and module (title, intro, outcomes, icon, accent, the
// optional flag) come from packages/catalogue/paths.json, the same file the
// console launcher reads, so an intro is written once. Grouping, ordering and
// totals are dashboard/src/launcher-model.js, the same code the launcher runs.
//
// The page has no JavaScript. Icons are inline SVG from the launcher's glyph
// table, accents are the --accent-* tokens of /design/tokens.css (the page
// pins data-theme="light", because the site has no dark theme).
//
// Library use: `renderLabsPage(labs, meta?) -> string` is pure. `labs` is an
// array of parsed manifests (only slug, title, summary, type, path, module,
// order, tier, estimated_minutes and difficulty are read); `meta` defaults to
// paths.json. Everything that comes from a manifest or from the copy is
// HTML-escaped.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ICONS, approxMinutes, buildLauncherModel } from '../dashboard/src/launcher-model.js';
import { WARM_UP_CHIP, labTypeLabel } from '../dashboard/src/words.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LABS_DIR = join(root, 'labs');
export const OUTPUT_FILE = join(root, 'site', 'public', 'labs.html');
export const PATHS_FILE = join(root, 'packages', 'catalogue', 'paths.json');

/** The catalogue copy: paths in display order, each with its modules. */
export function loadPathMeta(file = PATHS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const SUMMARY_LIMIT = 200;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** HTML-escape text for element content and double-quoted attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Collapse whitespace, then cut at a word boundary near `limit` and add an ellipsis. */
export function truncateSummary(text, limit = SUMMARY_LIMIT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  let cut = flat.slice(0, limit + 1);
  const space = cut.lastIndexOf(' ');
  cut = space > 0 ? cut.slice(0, space) : cut.slice(0, limit);
  return `${cut.replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const word = (n) => NUMBER_WORDS[n] ?? String(n);
const isFree = (lab) => lab.tier === 'free';

function chip(text, extraClass = '') {
  return `<span class="lab-chip${extraClass ? ` ${extraClass}` : ''}">${escapeHtml(text)}</span>`;
}

function renderLab(lab) {
  const free = isFree(lab);
  const chips = [];
  if (lab.type) chips.push(chip(labTypeLabel(lab.type)));
  if (lab.type === 'warm-up') chips.push(chip(WARM_UP_CHIP));
  if (lab.estimated_minutes) chips.push(chip(`~${lab.estimated_minutes} min`));
  if (lab.difficulty) chips.push(chip(lab.difficulty));
  chips.push(free ? chip('Free', 'lab-chip-free') : chip('Pro', 'lab-chip-pro'));

  const title = escapeHtml(lab.title);
  const cta = free
    ? `<a class="btn btn-accent btn-sm" href="/try" aria-label="Try it: ${title}">Try it</a>`
    : `<a class="btn btn-ghost btn-sm" href="/waitlist?from=labs" aria-label="Join the waitlist: ${title}">Join the waitlist</a>`;

  return [
    `          <li class="lab-card${free ? ' lab-card-free' : ''}">`,
    `            <h4>${title}</h4>`,
    `            <p>${escapeHtml(truncateSummary(lab.summary))}</p>`,
    `            <div class="lab-chips">${chips.join('')}</div>`,
    `            ${cta}`,
    '          </li>',
  ].join('\n');
}

/** A 24px stroke glyph from the launcher's table, inline so the page needs no file and no script. */
function glyph(name, size) {
  const paths = ICONS[name] ?? ICONS.grid;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function renderGrid(entries, indent) {
  const pad = ' '.repeat(indent);
  return [`${pad}<ul class="lab-grid" role="list">`, entries.map((e) => renderLab(e.lab)).join('\n'), `${pad}</ul>`].join('\n');
}

/** "31 labs · about 21 h · 2 free": what a path holds. Empty parts are left out. */
function pathStats(totals) {
  const stats = [plural(totals.labs, 'lab', 'labs')];
  const approx = approxMinutes(totals.minutes);
  if (approx) stats.push(`about ${approx}`);
  if (totals.free) stats.push(`${totals.free} free`);
  return stats;
}

/** "5 labs · ~2 h · 1 free" */
function moduleMeta(totals) {
  const parts = [plural(totals.labs, 'lab', 'labs')];
  const approx = approxMinutes(totals.minutes);
  if (approx) parts.push(`~${approx}`);
  if (totals.free) parts.push(`${totals.free} free`);
  return parts.join(' &middot; ');
}

function renderModule(path, module) {
  const id = `${path.slug}-module-${module.number}`;
  const head = [
    `        <section class="labs-module" id="${id}" data-accent="${module.accent}"${module.optional ? ' data-optional="true"' : ''} aria-labelledby="${id}-title">`,
    '          <div class="labs-module-head">',
    `            <span class="labs-tile labs-tile-sm" aria-hidden="true">${glyph(module.icon, 28)}</span>`,
    '            <div class="labs-module-text">',
  ];
  const eyebrow = [];
  if (module.known) eyebrow.push(`<span class="mono">${escapeHtml(module.eyebrow)}</span>`);
  if (module.optional) eyebrow.push('<span class="labs-badge">Optional</span>');
  if (eyebrow.length) head.push(`              <p class="labs-eyebrow">${eyebrow.join(' ')}</p>`);
  head.push(`              <h3 id="${id}-title">${escapeHtml(module.title)}</h3>`);
  if (module.intro) head.push(`              <p class="labs-module-intro">${escapeHtml(module.intro)}</p>`);
  head.push(`              <p class="labs-module-meta mono">${moduleMeta(module.totals)}</p>`);
  head.push('            </div>');
  if (module.outcomes.length) {
    head.push(
      '            <div class="labs-skills">',
      '              <p class="labs-skills-label mono">You will learn to</p>',
      '              <ul role="list">',
      ...module.outcomes.map((skill) => `                <li>${escapeHtml(skill)}</li>`),
      '              </ul>',
      '            </div>',
    );
  }
  head.push('          </div>', renderGrid(module.labs, 10), '        </section>');
  return head.join('\n');
}

function renderPath(path) {
  const id = path.slug;
  const parts = [
    `      <section class="labs-path" id="${id}" data-accent="${path.accent}" aria-labelledby="${id}-title">`,
    '        <div class="labs-path-head">',
    `          <span class="labs-tile" aria-hidden="true">${glyph(path.icon, 34)}</span>`,
    '          <div class="labs-path-text">',
    `            <p class="labs-eyebrow mono">PATH ${String(path.number).padStart(2, '0')}</p>`,
    `            <h2 id="${id}-title">${escapeHtml(path.title)}</h2>`,
  ];
  if (path.intro) parts.push(`            <p class="labs-path-intro">${escapeHtml(path.intro)}</p>`);
  parts.push(
    '            <ul class="labs-stats mono" role="list">',
    ...pathStats(path.totals).map((stat) => `              <li>${escapeHtml(stat)}</li>`),
    '            </ul>',
    '          </div>',
    '        </div>',
  );

  if (path.cards) {
    parts.push('        <div class="labs-modules">', path.modules.map((m) => renderModule(path, m)).join('\n'), '        </div>');
  } else {
    parts.push(renderGrid(path.modules[0].labs, 8));
  }
  parts.push('      </section>');
  return parts.join('\n');
}

const ARROW =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const TITLE = 'Every lab · Opalix';

/** Render the whole page. Pure: same input, same string. */
export function renderLabsPage(labs, meta = loadPathMeta()) {
  const known = new Set(meta.paths.map((p) => p.slug));
  for (const lab of labs) {
    if (!known.has(lab.path)) {
      throw new Error(`lab "${lab.slug}" has unknown path "${lab.path}"; describe it in packages/catalogue/paths.json`);
    }
  }

  // The launcher's own grouping: paths in the order of the copy, modules by number,
  // labs by order. Nothing here is signed in, so nothing is done.
  const { paths: shown, totals } = buildLauncherModel(labs, meta, { passed: new Set() });
  const total = totals.labs;
  const freeCount = totals.free;
  const moduleCount = shown.filter((p) => p.cards).reduce((n, p) => n + p.modules.length, 0);

  const stats = `${plural(total, 'lab', 'labs')} &middot; ${plural(shown.length, 'path', 'paths')} &middot; ${plural(moduleCount, 'module', 'modules')}`;
  const intro =
    freeCount > 0
      ? `Every lab in the beta, grouped by path and module: ${word(freeCount)} ${freeCount === 1 ? 'is' : 'are'} free to try now and the rest are on the waitlist.`
      : 'Every lab in the beta, grouped by path and module. They are all on the waitlist.';
  const description = `Every Opalix lab, grouped by path and module: ${plural(total, 'lab', 'labs')} in the beta, ${word(freeCount)} free to try and the rest on the waitlist.`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(TITLE)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="Every lab: Opalix">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://opalix.ai/labs">
<meta name="theme-color" content="#0a0f2c">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/funnel-display-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/design/tokens.css">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<!--
  GENERATED by scripts/build-labs-page.mjs from labs/*/manifest.yaml and
  packages/catalogue/paths.json. Do not edit by hand: change a manifest, the
  copy or the script, then run
  node scripts/build-labs-page.mjs
-->
<a class="skip" href="#main">Skip to content</a>

<header class="site-header">
  <div class="nav">
    <a class="brand" href="/" aria-label="Opalix home">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="#0a0f2c"/><circle cx="12" cy="12" r="4.5" fill="#3552f2"/></svg>
      <span>opalix</span>
      <span class="beta-tag">BETA</span>
    </a>
    <nav class="nav-links" aria-label="Main">
      <a href="/#tracks">Paths</a>
      <a href="/labs" aria-current="page">Labs</a>
      <a href="/#inside">How it works</a>
      <a href="/#pricing">Pricing</a>
    </nav>
    <div class="nav-actions">
      <a class="btn btn-accent btn-sm keep-mobile" href="/try">Try it free ${ARROW}</a>
    </div>
  </div>
</header>

<main id="main" class="labs-page">
  <div class="wrap">
    <div class="labs-intro">
      <span class="chip-tag"><span class="dot" aria-hidden="true"></span>LABS</span>
      <h1 class="h2">Every lab</h1>
      <p class="lede">${escapeHtml(intro)}</p>
      <p class="mono small muted">${stats}</p>
    </div>

${shown.map(renderPath).join('\n\n')}
  </div>
</main>

<footer class="site-footer">
  <div class="wrap footer-row">
    <span class="badge badge-accent mono">BETA</span>
    <span>Hands-on labs for production AI engineering</span>
    <nav class="footer-links" aria-label="Footer">
      <a href="/#tracks">Paths</a>
      <a href="/labs" aria-current="page">Labs</a>
      <a href="/#pricing">Pricing</a>
      <a href="/feedback">Feedback</a>
      <a href="/privacy">Privacy</a>
      <a href="/status">Status</a>
    </nav>
  </div>
  <div class="wordmark" aria-hidden="true">opalix</div>
</footer>
</body>
</html>
`;
}

/** Read every labs/*\/manifest.yaml that has a `path` field. */
export function loadLabs(labsDir = LABS_DIR) {
  const labs = [];
  for (const name of readdirSync(labsDir).sort()) {
    const file = join(labsDir, name, 'manifest.yaml');
    if (!existsSync(file)) continue;
    const manifest = parse(readFileSync(file, 'utf8'));
    if (manifest && typeof manifest === 'object' && manifest.path) labs.push(manifest);
  }
  return labs;
}

function main(argv) {
  const check = argv.includes('--check');
  const fresh = renderLabsPage(loadLabs());
  if (check) {
    const committed = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : null;
    if (committed === fresh) {
      console.log('site/public/labs.html is up to date');
      return 0;
    }
    console.error('site/public/labs.html is out of date. Run: node scripts/build-labs-page.mjs');
    return 1;
  }
  writeFileSync(OUTPUT_FILE, fresh);
  console.log(`wrote site/public/labs.html (${loadLabs().length} labs)`);
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invoked) process.exit(main(process.argv.slice(2)));
