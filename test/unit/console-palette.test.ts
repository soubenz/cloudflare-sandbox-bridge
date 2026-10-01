import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The colours the terminal and the editor paint with (dashboard/src/palette.js) come from the
 * console's tokens, with the same values as fallbacks. A fallback that drifts from styles.css would
 * make the terminal a different navy from the window around it the moment the stylesheet failed to
 * load, so the two are compared here. Pure module, imported directly.
 */
const P = (await import('../../dashboard/src/palette.js' as string)) as {
  PALETTE_FALLBACKS: Record<string, string>;
  windowPalette: () => Record<string, string>;
  withAlpha: (hex: string, alpha: number) => string;
  monoFamily: () => string;
};

const css = readFileSync(join(__dirname, '../../dashboard/public/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const root = /^:root\s*\{([^}]*)\}/m.exec(css)![1]!;
const token = (name: string) => new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(root)?.[1]?.toLowerCase();

describe('the window palette', () => {
  it('falls back to exactly the values styles.css gives the tokens', () => {
    for (const [name, value] of Object.entries(P.PALETTE_FALLBACKS)) expect(token(name), name).toBe(value);
  });

  it('is the same navy in light and dark: the window tokens are in :root only', () => {
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="light"]'));
    for (const name of Object.keys(P.PALETTE_FALLBACKS)) expect(dark.includes(`${name}:`), `${name} must not differ in dark`).toBe(false);
    expect(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('* { box-sizing')).includes('--term-bg')).toBe(false);
  });

  it('gives the fallbacks where there is no page to read (a test, a failed stylesheet)', () => {
    const palette = P.windowPalette();
    expect(palette.terminal).toBe(P.PALETTE_FALLBACKS['--term-bg']);
    expect(palette.editor).toBe(P.PALETTE_FALLBACKS['--navy-deep']);
    expect(palette.text).toBe(P.PALETTE_FALLBACKS['--win-text']);
    expect(palette.accent).toBe(P.PALETTE_FALLBACKS['--accent-on-dark']);
    expect(P.monoFamily()).toContain('JetBrains Mono');
  });

  it('keeps the terminal a shade deeper than the editor, as the design draws it', () => {
    const lum = (hex: string) => parseInt(hex.slice(1), 16);
    expect(lum(P.PALETTE_FALLBACKS['--term-bg']!)).toBeLessThan(lum(P.PALETTE_FALLBACKS['--navy-deep']!));
  });
});

describe('withAlpha', () => {
  it('turns a hex colour into a translucent rgba', () => {
    expect(P.withAlpha('#9aabff', 0.3)).toBe('rgba(154, 171, 255, 0.3)');
    expect(P.withAlpha('050819', 0.5)).toBe('rgba(5, 8, 25, 0.5)');
  });

  it('hands back what it cannot read', () => {
    expect(P.withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple');
    expect(P.withAlpha('#fff', 0.5)).toBe('#fff');
  });
});
