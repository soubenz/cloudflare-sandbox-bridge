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
// console (dashboard/public/styles.css) carries a mirror of the design's
// palette (it does not load tokens.css) under its own variable names. The
// mirror of the accents must equal packages/design, and every colour pair the
// console draws as text (4.5:1) or as a boundary or fill that must be seen
// (3:1) is checked in both themes. No colour may be named outside the token
// blocks of styles.css (learn.css and session.css included). The motion comic
// (dashboard/public/comic.css) keeps its own token blocks, arranged the same
// way; its text-on-ground pairs are checked below and it too may name no colour
// outside them.
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

// The console's palette: light by default, dark under prefers-color-scheme
// (for a page with no data-theme) and under [data-theme="dark"]. The accent
// families are checked on its surfaces, its mirror of them is compared with the
// design tokens, and the pairs the console draws are checked below.
const consoleCssRaw = readFileSync(join(root, "dashboard/public/styles.css"), "utf8");
const consoleCss = consoleCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const consoleBody = (re, label) => {
  const m = consoleCss.match(re);
  if (!m) {
    console.error(`FAIL: could not find the ${label} block in dashboard/public/styles.css`);
    process.exit(1);
  }
  return m[1];
};
const cLightBody = consoleBody(/^:root\s*\{([^}]*)\}/m, "console :root (light)");
const cDarkAttrBody = consoleBody(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/, 'console [data-theme="dark"]');
const cDarkMediaBody = consoleBody(
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/,
  "console dark @media",
);
// Whole declarations, not just the hex ones: shadows and the scrim must agree too. color-scheme is the attribute block's own.
if (norm(cDarkMediaBody) !== norm(cDarkAttrBody.replace(/color-scheme\s*:\s*dark\s*;/, ""))) {
  console.error('\nFAIL: the console\'s dark @media block and [data-theme="dark"] block differ');
  failed++;
} else {
  console.log('\nconsole dark @media block and [data-theme="dark"] block are identical: ok');
}
const cLight = hexTokens(cLightBody);
const cDarkAttr = hexTokens(cDarkAttrBody);
const cDarkMedia = hexTokens(cDarkMediaBody);
const consoleThemes = {
  light: cLight,
  "dark (attr)": { ...cLight, ...cDarkAttr },
  "dark (media)": { ...cLight, ...cDarkMedia },
};
const consoleNames = { surface: "surface", bg: "bg", track: "surface-3", text: ["ink", "ink-2", "ink-muted"] };

// sRGB mix, as `color-mix(in srgb, a p%, b)` paints it, for the tinted progress tracks.
const mixHex = (a, b, p) => {
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

// [foreground, background, minimum ratio, what it is]. Text is 4.5:1; a boundary, a ring or a fill that
// must be seen is 3:1.
const consolePairs = [
  ["ink", "bg", 4.5, "text on the page"],
  ["ink", "surface", 4.5, "text on a card"],
  ["ink", "surface-2", 4.5, "text on a hovered row"],
  ["ink-2", "bg", 4.5, "secondary text on the page"],
  ["ink-2", "surface", 4.5, "secondary text on a card"],
  ["ink-2", "surface-2", 4.5, "secondary text on a hovered row"],
  ["ink-muted", "bg", 4.5, "muted text on the page"],
  ["ink-muted", "surface", 4.5, "muted text on a card"],
  ["ink-muted", "surface-2", 4.5, "muted text on a hovered row"],
  ["ink-muted", "surface-3", 4.5, "muted text on a chip or the account pill"],
  ["ink", "surface-3", 4.5, "text on the current nav link"],
  ["good", "bg", 4.5, "state: healthy, on the page"],
  ["good", "surface", 4.5, "state: healthy, on a card"],
  ["warn", "bg", 4.5, "state: warning, on the page"],
  ["warn", "surface", 4.5, "state: warning, on a card"],
  ["bad", "bg", 4.5, "state: failing, on the page"],
  ["bad", "surface", 4.5, "state: failing, on a card"],
  ["accent", "bg", 4.5, "accent text and links on the page"],
  ["accent", "surface", 4.5, "accent text and links on a card"],
  ["accent-text", "accent-soft", 4.5, "Suggested start, selected chip"],
  ["accent-text", "bg", 4.5, "accent text on the page"],
  ["ink", "accent-soft", 4.5, "text on the recap tint"],
  ["on-accent", "accent-fill", 4.5, "white on a primary button"],
  ["on-accent", "accent-fill-hover", 4.5, "white on a hovered primary button"],
  ["on-strong", "strong", 4.5, "Start and the current path pill"],
  ["chip-strong-fg", "chip-strong-bg", 4.5, "Running and Case file badges"],
  ["accent-on-dark", "chip-strong-bg", 4.5, "the LABS tag"],
  ["done-fg", "done-bg", 4.5, "a done check and the account initials"],
  ["on-accent", "resume-bg", 4.5, "text on the running-lab card"],
  ["navy-muted", "resume-bg", 4.5, "secondary text on the running-lab card"],
  ["accent-on-dark", "navy-line", 4.5, "RUNNING on the running-lab card"],
  ["navy-muted", "navy-line", 4.5, "the time left on a tinted chip"],
  ["code-text", "code-bg", 4.5, "code on its dark ground"],
  ["border-input", "surface", 3.0, "an input or checkbox edge on a card"],
  ["border-input", "bg", 3.0, "an input edge on the page"],
  ["border-input", "surface-2", 3.0, "an input edge on a quiet surface"],
  ["accent", "bg", 3.0, "the focus ring on the page"],
  ["accent", "surface", 3.0, "the focus ring on a card"],
  ["accent", "surface-3", 3.0, "the focus ring on a chip, and a progress fill against its track"],
  ["accent-fill", "bg", 3.0, "a primary button against the page"],
  ["accent-fill", "surface", 3.0, "a filled step or highlight against a card"],
  ["strong", "bg", 3.0, "the current path pill against the page"],
  ["done-bg", "surface", 3.0, "a done circle against a card"],
  ["ink-muted", "surface", 3.0, "the circle of an open lab row"],
  // The session screen (session.css): the guide on the page's surfaces ...
  ["ink-2", "surface-3", 4.5, "an inactive guide tab on the tab strip"],
  ["accent-text", "surface", 4.5, "links in the brief"],
  ["accent-text", "surface-2", 4.5, "links on a question card"],
  ["ink-muted", "surface-2", 4.5, "help under a question, a hint's label"],
  ["ink-2", "surface-2", 4.5, "a hint's text, a lesson's recap"],
  ["on-accent", "accent-fill", 4.5, "a chosen answer, a selected window tab"],
  ["accent-fill", "surface-2", 3.0, "a chosen answer against its card"],
  ["border-input", "surface-2", 3.0, "an answer pill, a field, the dashed hint slot"],
  ["accent-text", "accent-soft", 4.5, "the count on a guide tab"],
  ["accent-text", "surface-3", 4.5, "the count on a guide tab that is not selected"],
  ["done-fg", "done-bg", 4.5, "a passed check, a shown hint"],
  ["done-bg", "surface-2", 3.0, "a passed dot and check against a card"],
  // ... and the navy workspace window, the same in both themes.
  ["on-accent", "navy-deep", 4.5, "white on the window: its title, a hovered file"],
  ["navy-muted", "navy-deep", 4.5, "secondary text on the window: inactive tabs, file names"],
  ["navy-muted", "win-strip", 4.5, "the toolbars and the activity strip"],
  ["on-accent", "win-strip", 4.5, "the open file's name on its toolbar"],
  ["navy-muted", "win-hover", 4.5, "a hovered tab or file"],
  ["on-accent", "win-hover", 4.5, "a selected file, a hovered tab"],
  ["win-dim", "navy-deep", 4.5, "small labels on the window: Workspace, sizes"],
  ["win-dim", "win-strip", 4.5, "Lab activity, the notice count"],
  ["win-muted", "navy-deep", 4.5, "line numbers in the editor"],
  ["win-text", "navy-deep", 4.5, "code in the editor"],
  ["win-text", "term-bg", 4.5, "text in the terminal"],
  ["accent-on-dark", "term-bg", 4.5, "the terminal's cursor and prompt"],
  ["accent-on-dark", "win-chip", 4.5, "the RUNNING pill"],
  ["win-warn", "win-warn-bg", 4.5, "a starting lab, a dropped stream"],
  ["win-fail", "win-fail-bg", 4.5, "an ended lab"],
  ["win-warn", "navy-deep", 4.5, "the idle clock and the unsaved mark on the window"],
  ["win-warn", "win-strip", 4.5, "unsaved, on the editor's toolbar"],
  ["win-fail", "navy-deep", 4.5, "an error in the file tree"],
  ["win-ok", "win-strip", 4.5, "saved, on the editor's toolbar"],
  ["accent-on-dark", "navy-deep", 3.0, "the focus ring inside the window"],
  ["accent-fill", "navy-deep", 3.0, "the selected window tab against the window"],
  // The motion comic's two buttons and its timecode, on the learning card and in the guide.
  ["ink", "surface", 4.5, "Replay, the comic's outlined button"],
  ["on-strong", "strong", 4.5, "Skip, the comic's navy button"],
  ["ink-muted", "surface", 4.5, "the comic's timecode"],
  ["ink-muted", "surface-2", 4.5, "the comic's timecode in the guide"],
  ["ink-2", "surface-2", 4.5, "Read as text, and the transcript under the comic"],
  ["win-ok", "navy-deep", 3.0, "a healthy service's dot"],
  ["win-warn", "navy-deep", 3.0, "a restarting service's dot"],
];

// [foreground, the colour it is mixed into, the tint, the share of the tint, minimum, what it is]: text on a
// `color-mix(in srgb, tint share%, base)` ground, as the banners, badges and the result card paint it.
const consoleTints = [
  ["ink", "surface", "warn", 0.12, 4.5, "text on the idle and expiry banners"],
  ["ink", "surface", "bad", 0.12, 4.5, "text on the ended banner"],
  ["ink", "surface", "good", 0.1, 4.5, "text on the result card"],
  ["ink-2", "surface", "good", 0.1, 4.5, "the lab's name on the result card"],
  ["ink-muted", "surface", "good", 0.1, 4.5, "the stat labels on the result card"],
  ["accent-green-ink", "surface", "good", 0.1, 4.5, "Lab complete"],
  ["warn", "surface", "warn", 0.14, 4.5, "a check that has not passed yet, a timed-out check"],
  ["bad", "surface", "bad", 0.14, 4.5, "a failed check's mark"],
];
for (const [theme, tokens] of Object.entries(consoleThemes)) {
  accentPairs(`console ${theme}`, tokens, consoleNames);
  for (const [fg, bg, min, what] of consolePairs) {
    const a = tokens[fg];
    const b = tokens[bg];
    if (!a || !b) {
      failed++;
      rows2.push([`console ${theme}`, `${fg} on ${bg} (${what})`, "missing", String(min), "-", "FAIL"]);
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failed++;
    rows2.push([`console ${theme}`, `${fg} on ${bg} (${what})`, r.toFixed(2), String(min), "-", ok ? "ok" : "FAIL"]);
  }
  for (const [fg, base, tint, share, min, what] of consoleTints) {
    const a = tokens[fg];
    const b = tokens[base] && tokens[tint] ? mixHex(tokens[tint], tokens[base], share) : null;
    const r = a && b ? ratio(a, b) : 0;
    const ok = Boolean(a && b && r >= min);
    if (!ok) failed++;
    rows2.push([`console ${theme}`, `${fg} on ${tint} ${Math.round(share * 100)}% in ${base} (${what})`, a && b ? r.toFixed(2) : "missing", String(min), "-", ok ? "ok" : "FAIL"]);
  }
  // A module's progress fill on its own tinted track (18% of the accent into the card colour).
  let worst = { r: Infinity, n: "" };
  for (const n of ACCENTS) {
    const r = ratio(tokens[`accent-${n}`], mixHex(tokens[`accent-${n}`], tokens.surface, 0.18));
    if (r < worst.r) worst = { r, n };
  }
  {
    const ok = worst.r >= 3;
    if (!ok) failed++;
    rows2.push([`console ${theme}`, "module progress fill on its tinted track (worst of 8)", worst.r.toFixed(2), "3", worst.n, ok ? "ok" : "FAIL"]);
  }
}

// ---------------------------------------------------------------------------
// The motion comic (dashboard/public/comic.css): its own token blocks, the same
// three as the console's (light, dark under prefers-color-scheme, dark under
// data-theme), and every pair of text and ground it draws, in each theme.
{
  const comicCss = readFileSync(join(root, "dashboard/public/comic.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const grab = (re, label) => {
    const m = comicCss.match(re);
    if (!m) {
      console.error(`FAIL: could not find the ${label} block in dashboard/public/comic.css`);
      process.exit(1);
    }
    return m[1];
  };
  const cmLightBody = grab(/^:root\s*\{([^}]*)\}/m, "comic :root (light)");
  const cmAttrBody = grab(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/, 'comic [data-theme="dark"]');
  const cmMediaBody = grab(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/, "comic dark @media");
  if (norm(cmMediaBody) !== norm(cmAttrBody)) {
    console.error('\nFAIL: the comic\'s dark @media block and [data-theme="dark"] block differ');
    failed++;
  } else {
    console.log('\ncomic dark @media block and [data-theme="dark"] block are identical: ok');
  }
  const cmLight = hexTokens(cmLightBody);
  const comicThemes = {
    light: cmLight,
    "dark (attr)": { ...cmLight, ...hexTokens(cmAttrBody) },
    "dark (media)": { ...cmLight, ...hexTokens(cmMediaBody) },
  };
  const grounds = ["ice", "sand", "mint", "navy", "lilac", "cobalt", "rose"];
  const comicPairs = [
    ...grounds.map((n) => [`fg-${n}`, `bg-${n}`, 4.5, `words drawn straight on the ${n} panel`]),
    ["ink", "bubble", 4.5, "speech bubble text"],
    ["ink", "caption", 4.5, "caption text, the highlighted word of the closing panel"],
    ["bubble", "ink", 4.5, "a speaker's name tag"],
    ["chip-fg", "chip-bg", 4.5, "the page number on a title card"],
    ["fg-paper", "paper", 4.5, "a page's title card"],
    ["screen-text", "screen-bg", 4.5, "a typed command on a screen"],
    ["screen-out", "screen-bg", 4.5, "a screen's output"],
    ["screen-ok", "screen-bg", 4.5, "a screen's success line"],
    ["screen-warn", "screen-bg", 4.5, "a screen's warning line"],
    ["sfx", "ink", 4.5, "a sound effect's fill against its outline"],
    ["edge", "paper", 3.0, "a panel's border against the page"],
    ["stage-bar", "stage", 3.0, "the progress bar against the frame"],
  ];
  const cmRows = [["comic theme", "pair", "ratio", "min", "ok"]];
  for (const [theme, tokens] of Object.entries(comicThemes)) {
    for (const [fg, bg, min, what] of comicPairs) {
      const a = tokens[`cm-${fg}`];
      const b = tokens[`cm-${bg}`];
      const r = a && b ? ratio(a, b) : 0;
      const ok = Boolean(a && b && r >= min);
      if (!ok) failed++;
      cmRows.push([theme, `${fg} on ${bg} (${what})`, a && b ? r.toFixed(2) : "missing", String(min), ok ? "ok" : "FAIL"]);
    }
    // A sound effect is large text with a thick outline: it must stand out from the panel by its fill or by its outline.
    for (const n of grounds) {
      const sfx = tokens["cm-sfx"];
      const ink = tokens["cm-ink"];
      const bg = tokens[`cm-bg-${n}`];
      const r = sfx && ink && bg ? Math.max(ratio(sfx, bg), ratio(ink, bg)) : 0;
      const ok = r >= 3;
      if (!ok) failed++;
      cmRows.push([theme, `sfx or its outline on bg-${n} (a sound effect on the ${n} panel)`, r.toFixed(2), "3", ok ? "ok" : "FAIL"]);
    }
  }
  const cw = cmRows[0].map((_, i) => Math.max(...cmRows.map((r) => r[i].length)));
  console.log("");
  for (const r of cmRows) console.log(r.map((c, i) => c.padEnd(cw[i])).join("  ").trimEnd());
}

// Nothing but the token blocks may name a colour: every other rule reads a variable.
{
  const stripped = (css) =>
    css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^:root\s*\{[^}]*\}/m, "")
      .replace(/:root\[data-theme="dark"\]\s*\{[^}]*\}/, "")
      .replace(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{[^}]*\}\s*\}/, "");
  for (const file of ["styles.css", "learn.css", "session.css", "comic.css", "profile.css", "admin-mode.css"]) {
    const body = stripped(readFileSync(join(root, "dashboard/public", file), "utf8"));
    const strays = [];
    for (const m of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const v of m[1].matchAll(/(?::|\s)(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g)) strays.push(v[1]);
    }
    console.log(`\ndashboard/public/${file} names no colour outside its token blocks: ${strays.length ? "FAIL" : "ok"}`);
    if (strays.length) {
      console.error(`  found: ${[...new Set(strays)].join(", ")}`);
      failed++;
    }
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
  mirrorOf(themes.light, consoleThemes.light, "light");
  mirrorOf(themes["dark-attr"], consoleThemes["dark (attr)"], "dark");
  mirrorOf(themes["dark-attr"], consoleThemes["dark (media)"], "dark (media)");
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
