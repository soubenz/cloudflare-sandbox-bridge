#!/usr/bin/env node
// WCAG contrast check for packages/design/tokens.css. No dependencies.
//
//   node scripts/contrast-check.mjs
//
// Parses the `--name: #hex` colour tokens out of the three blocks of
// tokens.css (light :root, dark under prefers-color-scheme, dark under
// [data-theme="dark"]), checks the pairs that are used as text or as a
// control boundary, and asserts the two dark blocks are identical. Exits 1
// on any failure. Also checks the copies under site/public/design/ match.
//
// The accent families (--accent-<name>, -soft, -ink) are checked twice: on the
// design tokens' own surfaces, and on the console's surfaces, because the
// console (dashboard/public/styles.css) has its own palette and carries a
// mirror of the accent values. The mirror must equal packages/design.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "packages/design/tokens.css"), "utf8")
  // Strip comments so a "{" or "--x: #fff;" inside one cannot confuse the regexes.
  .replace(/\/\*[\s\S]*?\*\//g, "");

function block(re, label) {
  const m = css.match(re);
  if (!m) {
    console.error(`FAIL: could not find the ${label} block in tokens.css`);
    process.exit(1);
  }
  return m[1];
}

const bodies = {
  light: block(/^:root\s*\{([^}]*)\}/m, "light :root"),
  "dark-media": block(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/,
    "dark @media",
  ),
  "dark-attr": block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/, 'dark [data-theme="dark"]'),
};

function hexTokens(body) {
  const out = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const light = hexTokens(bodies.light);
// A dark block only lists what changes; anything else (the code-* tokens)
// is inherited from :root, so resolve against the light values.
const themes = {
  light,
  "dark-media": { ...light, ...hexTokens(bodies["dark-media"]) },
  "dark-attr": { ...light, ...hexTokens(bodies["dark-attr"]) },
};

function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio]
const pairs = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text-muted", "bg", 4.5],
  ["text-muted", "surface", 4.5],
  ["success", "surface", 4.5],
  ["warn", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["accent-contrast", "accent", 4.5],
  ["border-input", "surface", 3.0],
  ["code-text", "code-bg", 4.5],
];

let failed = 0;
const rows = [["theme", "pair", "ratio", "min", "ok"]];
for (const [theme, tokens] of Object.entries(themes)) {
  for (const [fg, bg, min] of pairs) {
    const a = tokens[`color-${fg}`];
    const b = tokens[`color-${bg}`];
    if (!a || !b) {
      rows.push([theme, `${fg} on ${bg}`, "missing", String(min), "FAIL"]);
      failed++;
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failed++;
    rows.push([theme, `${fg} on ${bg}`, r.toFixed(2), String(min), ok ? "ok" : "FAIL"]);
  }
}

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());

// The two dark blocks must be the same declarations, whatever the indentation.
const norm = (body) => body.split(";").map((d) => d.replace(/\s+/g, " ").trim()).filter(Boolean).join(";\n");
if (norm(bodies["dark-media"]) !== norm(bodies["dark-attr"])) {
  console.error("\nFAIL: the dark @media block and the [data-theme=\"dark\"] block differ");
  failed++;
} else {
  console.log("\ndark @media block and [data-theme=\"dark\"] block are identical: ok");
}

// ---------------------------------------------------------------------------
// Accent families.
//
// Text (the -ink token, and the normal text tokens on a tint) needs 4.5:1.
// Anything that is not text but must be seen (the stripe, the icon glyph on
// its tile, the progress fill against its track) needs 3:1.
const ACCENTS = Object.keys(light)
  .map((k) => k.match(/^accent-([a-z]+)$/)?.[1])
  .filter(Boolean);
if (ACCENTS.length !== 8) {
  console.error(`FAIL: expected 8 accent families in tokens.css, found ${ACCENTS.length}`);
  failed++;
}

/**
 * One surface set = the names of the tokens a theme calls its plain page,
 * card, track and text colours. `tokens` is the resolved theme.
 */
const reported = new Set();
function accentPairs(label, tokens, names) {
  const t = (n) => tokens[n];
  const groups = new Map(); // "theme  pair" -> { min, who, need }
  const add = (pair, fg, bg, need, who) => {
    const a = t(fg);
    const b = t(bg);
    let r = 0;
    if (a && b) r = ratio(a, b);
    else {
      for (const missing of [a ? null : fg, b ? null : bg]) {
        if (missing && !reported.has(`${label}/${missing}`)) {
          reported.add(`${label}/${missing}`);
          console.error(`FAIL: ${label}: no colour token "${missing}"`);
        }
      }
    }
    const g = groups.get(pair) ?? { min: Infinity, who: "", need };
    if (!(a && b)) g.min = 0;
    if (r < g.min) { g.min = r; g.who = who; }
    groups.set(pair, g);
  };
  for (const n of ACCENTS) {
    const acc = `accent-${n}`;
    const soft = `accent-${n}-soft`;
    const ink = `accent-${n}-ink`;
    // Non-text, 3:1
    add("accent (stripe, icon) on surface", acc, names.surface, 3.0, n);
    add("accent (stripe, icon) on page", acc, names.bg, 3.0, n);
    add("accent (icon glyph) on its tint", acc, soft, 3.0, n);
    add("accent (progress fill) on track", acc, names.track, 3.0, n);
    // Text, 4.5:1
    add("accent-ink on surface", ink, names.surface, 4.5, n);
    add("accent-ink on its tint", ink, soft, 4.5, n);
    for (const txt of names.text) {
      add(`${txt} on an accent tint`, txt, soft, 4.5, n);
    }
  }
  for (const [pair, g] of groups) {
    const ok = g.min >= g.need;
    if (!ok) failed++;
    rows2.push([label, pair, g.min.toFixed(2), String(g.need), g.who, ok ? "ok" : "FAIL"]);
  }
}

const rows2 = [["surfaces", "pair (worst of 8 accents)", "ratio", "min", "worst", "ok"]];
const designNames = { surface: "color-surface", bg: "color-bg", track: "color-border", text: ["color-text", "color-text-muted"] };
for (const [theme, tokens] of Object.entries(themes)) accentPairs(`design ${theme}`, tokens, designNames);

// The console has its own palette (dark by default, two light blocks), so the
// accents are checked on its surfaces, and its mirror of them is compared
// with the design tokens.
const consoleCss = readFileSync(join(root, "dashboard/public/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const consoleBody = (re, label) => {
  const m = consoleCss.match(re);
  if (!m) {
    console.error(`FAIL: could not find the ${label} block in dashboard/public/styles.css`);
    process.exit(1);
  }
  return m[1];
};
const cDark = hexTokens(consoleBody(/^:root\s*\{([^}]*)\}/m, "console :root (dark)"));
const cLightAttr = hexTokens(consoleBody(/:root\[data-theme="light"\]\s*\{([^}]*)\}/, 'console [data-theme="light"]'));
const cLightMedia = hexTokens(
  consoleBody(
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/,
    "console light @media",
  ),
);
const sameTokens = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
if (!sameTokens(cLightAttr, cLightMedia)) {
  console.error('\nFAIL: the console\'s light @media block and [data-theme="light"] block differ');
  failed++;
}
const consoleThemes = { dark: cDark, "light (attr)": { ...cDark, ...cLightAttr }, "light (media)": { ...cDark, ...cLightMedia } };
const consoleNames = { surface: "surface", bg: "bg", track: "border", text: ["ink", "ink-2", "ink-muted"] };
for (const [theme, tokens] of Object.entries(consoleThemes)) {
  accentPairs(`console ${theme}`, tokens, consoleNames);
  // What the launcher also puts on the plain page and card.
  for (const [fg, bg] of [["ink", "bg"], ["ink", "surface"], ["ink-2", "surface"], ["ink-muted", "bg"], ["ink-muted", "surface"]]) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= 4.5;
    if (!ok) failed++;
    rows2.push([`console ${theme}`, `${fg} on ${bg}`, r.toFixed(2), "4.5", "-", ok ? "ok" : "FAIL"]);
  }
}
// The public /labs page sits on the marketing site's own light palette
// (site/public/styles.css :root) and loads the design tokens' light accents,
// pinned with data-theme="light" because the site has no dark theme.
{
  const siteCss = readFileSync(join(root, "site/public/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const siteRoot = hexTokens(siteCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "");
  const accents = Object.fromEntries(Object.entries(themes.light).filter(([k]) => k.startsWith("accent-")));
  const siteTokens = { ...siteRoot, ...accents };
  accentPairs("site /labs", siteTokens, { surface: "surface", bg: "bg", track: "border", text: ["ink", "ink-2", "muted"] });
  // The page pins the light theme; without that attribute a system dark preference would swap the accents.
  const labsHtml = readFileSync(join(root, "site/public/labs.html"), "utf8");
  const pinned = /<html[^>]*data-theme="light"/.test(labsHtml) && labsHtml.includes('href="/design/tokens.css"');
  console.log(`\nsite/public/labs.html loads /design/tokens.css with data-theme="light": ${pinned ? "ok" : "FAIL"}`);
  if (!pinned) failed++;
}
{
  const w2 = rows2[0].map((_, i) => Math.max(...rows2.map((r) => r[i].length)));
  console.log("");
  for (const r of rows2) console.log(r.map((c, i) => c.padEnd(w2[i])).join("  ").trimEnd());
}

// The console's copy of the accent values is the design's, theme for theme.
{
  const mirrorOf = (design, mirror, label) => {
    const wanted = Object.entries(design).filter(([k]) => k.startsWith("accent-"));
    const differs = wanted.filter(([k, v]) => mirror[k] !== v).map(([k]) => k);
    console.log(`\nconsole ${label} accent tokens mirror packages/design: ${differs.length ? "FAIL" : "ok"}`);
    if (differs.length) {
      console.error(`  differs or missing: ${differs.join(", ")}`);
      failed++;
    }
  };
  mirrorOf(themes.light, consoleThemes["light (attr)"], "light");
  mirrorOf(themes["dark-attr"], consoleThemes.dark, "dark");
}

// The site serves these straight from site/public (no build step), so the
// committed copies must not drift from packages/design.
for (const f of ["tokens.css", "fonts.css"]) {
  const src = join(root, "packages/design", f);
  const dst = join(root, "site/public/design", f);
  let same = false;
  try { same = readFileSync(src, "utf8") === readFileSync(dst, "utf8"); } catch {}
  console.log(`site/public/design/${f} matches packages/design/${f}: ${same ? "ok" : "FAIL"}`);
  if (!same) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
