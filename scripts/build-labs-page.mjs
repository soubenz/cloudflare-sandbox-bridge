#!/usr/bin/env node
// Builds the public "every lab" page, site/public/labs.html, from the lab
// manifests.
//
//   node scripts/build-labs-page.mjs           write site/public/labs.html
//   node scripts/build-labs-page.mjs --check   exit 1 if the committed file
//                                              differs from a fresh render
//
// The site has no build step, so the generated page is committed; --check (and
// test/unit/build-labs-page.test.ts) catch a manifest change that was not
// followed by a rebuild.
//
// A lab is listed when its manifest has a `path` field. The fixture labs
// (hello, fragile, impatient, gateway-hello, gateway-litellm-hello) have none
// and are skipped, as are labs still being written without a catalogue slot.
//
// Library use: `renderLabsPage(labs) -> string` is pure. `labs` is an array of
// parsed manifests (only slug, title, summary, type, path, module, order,
// tier, estimated_minutes and difficulty are read). Everything that comes from
// a manifest is HTML-escaped.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LABS_DIR = join(root, 'labs');
export const OUTPUT_FILE = join(root, 'site', 'public', 'labs.html');

/** Paths in display order. Slugs match `path:` in the manifests. */
export const PATHS = [
  {
    slug: 'production-agents',
    title: 'Production agents essentials',
    description:
      'How agents fail at scale and how to prevent it: cost, retries, state and tool output you cannot trust. Every lab here starts broken in production, and you fix it while something fights back.',
  },
  {
    slug: 'securing-agents',
    title: 'Securing agents',
    description:
      'Keep an agent from leaking what it can reach or doing what it should not. The first lab starts from a code tool that read a secrets file it should never have seen.',
    morePlanned: true,
  },
  {
    slug: 'ai-platform',
    title: 'Building an AI platform',
    description:
      'The platform that agents and models run on, in seven modules from gateways and access to compliance. Most labs ask you to build the missing piece, and a few let you explore a working system first.',
  },
  {
    slug: 'evals-releases',
    title: 'Evals and safe releases',
    description:
      'Catch a bad change before your customers do. The first lab starts from a prompt change that shipped while nothing measured whether it made replies worse.',
    morePlanned: true,
  },
];

/** Module headings for the platform path, by `module` number. */
export const MODULE_NAMES = {
  'ai-platform': {
    1: 'Gateway and access',
    2: 'Tools and MCP',
    3: 'Retrieval as a service',
    4: 'Observability and cost',
    5: 'Runtime and durability',
    6: 'Self-service and golden paths',
    7: 'Compliance and sovereignty',
  },
};

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
const byOrder = (a, b) =>
  (a.order ?? 0) - (b.order ?? 0) || String(a.title ?? '').localeCompare(String(b.title ?? '')) || String(a.slug).localeCompare(String(b.slug));

function chip(text, extraClass = '') {
  return `<span class="lab-chip${extraClass ? ` ${extraClass}` : ''}">${escapeHtml(text)}</span>`;
}

function renderLab(lab) {
  const free = isFree(lab);
  const chips = [];
  if (lab.type) chips.push(chip(lab.type));
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

function renderGrid(labs) {
  return ['        <ul class="lab-grid" role="list">', labs.map(renderLab).join('\n'), '        </ul>'].join('\n');
}

function renderPath(def, index, labs) {
  const modules = [...new Set(labs.map((l) => l.module ?? 1))].sort((a, b) => a - b);
  const id = def.slug;
  const parts = [
    `      <section class="labs-path" id="${id}" aria-labelledby="${id}-title">`,
    '        <div class="labs-path-head">',
    `          <span class="mono muted">PATH ${String(index + 1).padStart(2, '0')} &middot; ${escapeHtml(plural(labs.length, 'lab', 'labs'))}</span>`,
    `          <h2 id="${id}-title">${escapeHtml(def.title)}</h2>`,
    `          <p>${escapeHtml(def.description)}</p>`,
    '        </div>',
  ];

  if (modules.length === 1) {
    parts.push(renderGrid([...labs].sort(byOrder)));
  } else {
    for (const m of modules) {
      const inModule = labs.filter((l) => (l.module ?? 1) === m).sort(byOrder);
      const name = MODULE_NAMES[def.slug]?.[m] ?? `Module ${m}`;
      parts.push(
        '        <div class="labs-module">',
        `          <h3><span class="mono">${m}</span> ${escapeHtml(name)}</h3>`,
        renderGrid(inModule),
        '        </div>',
      );
    }
  }

  if (def.morePlanned) {
    parts.push(
      '        <p class="labs-more">More labs are planned for this path. They are not built yet, so they are not listed here.</p>',
    );
  }
  parts.push('      </section>');
  return parts.join('\n');
}

const ARROW =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const TITLE = 'Every lab · Opalix';

/** Render the whole page. Pure: same input, same string. */
export function renderLabsPage(labs) {
  const known = new Set(PATHS.map((p) => p.slug));
  for (const lab of labs) {
    if (!known.has(lab.path)) {
      throw new Error(`lab "${lab.slug}" has unknown path "${lab.path}"; add it to PATHS in scripts/build-labs-page.mjs`);
    }
  }

  const shown = PATHS.map((def) => ({ def, labs: labs.filter((l) => l.path === def.slug) })).filter((p) => p.labs.length > 0);
  const total = labs.length;
  const freeCount = labs.filter(isFree).length;
  const moduleCount = new Set(labs.filter((l) => l.path === 'ai-platform').map((l) => l.module ?? 1)).size;

  const stats = `${plural(total, 'lab', 'labs')} &middot; ${plural(shown.length, 'path', 'paths')} &middot; ${plural(moduleCount, 'platform module', 'platform modules')}`;
  const intro =
    freeCount > 0
      ? `Every lab in the beta, grouped by path and module: ${word(freeCount)} ${freeCount === 1 ? 'is' : 'are'} free to try now and the rest are on the waitlist.`
      : 'Every lab in the beta, grouped by path and module. They are all on the waitlist.';
  const description = `Every Opalix lab, grouped by path and module: ${plural(total, 'lab', 'labs')} in the beta, ${word(freeCount)} free to try and the rest on the waitlist.`;

  return `<!doctype html>
<html lang="en">
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
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<!--
  GENERATED by scripts/build-labs-page.mjs from labs/*/manifest.yaml. Do not
  edit by hand: change a manifest or the script, then run
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

${shown.map((p) => renderPath(p.def, PATHS.indexOf(p.def), p.labs)).join('\n\n')}
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
