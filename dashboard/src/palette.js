/**
 * The colours the terminal and the editor paint with, read from the console's
 * own tokens (styles.css) so they are the workspace window's colours and cannot
 * drift from it. xterm.js and CodeMirror take colour strings, not CSS, so they
 * cannot simply use a variable; the fallbacks are the same values the tokens
 * hold (test/unit/console-palette.test.ts compares them with styles.css).
 *
 * The window is the landing page's navy product window in both themes, so
 * nothing here depends on the light or dark setting.
 */

/** token name -> the value styles.css gives it. */
export const PALETTE_FALLBACKS = {
  '--term-bg': '#050819',
  '--navy-deep': '#070b22',
  '--navy-line': '#1c2446',
  '--win-strip': '#0b1130',
  '--win-hover': '#121a42',
  '--win-text': '#d9dcea',
  '--win-muted': '#7a82a8',
  '--accent-on-dark': '#9aabff',
};

const read = (name) => {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || PALETTE_FALLBACKS[name];
  } catch {
    return PALETTE_FALLBACKS[name];
  }
};

/** `#rrggbb` as an rgba() string at `alpha`, for the translucent selection colours. */
export function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The window's colours, by the job they do. */
export function windowPalette() {
  return {
    terminal: read('--term-bg'),
    editor: read('--navy-deep'),
    line: read('--navy-line'),
    strip: read('--win-strip'),
    hover: read('--win-hover'),
    text: read('--win-text'),
    muted: read('--win-muted'),
    accent: read('--accent-on-dark'),
  };
}

/** The monospace stack the page uses (JetBrains Mono, then the system's), for xterm and CodeMirror. */
export function monoFamily() {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
    if (value) return value;
  } catch {
    /* fall through */
  }
  return "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
}
