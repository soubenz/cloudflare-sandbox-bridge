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
