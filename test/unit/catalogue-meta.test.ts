import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import meta from '../../packages/catalogue/paths.json';

/** Path and module of every lab that places itself in the catalogue. */
function placedLabs(): { slug: string; path: string; module: number }[] {
  const root = join(__dirname, '..', '..', 'labs');
  const out: { slug: string; path: string; module: number }[] = [];
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, 'manifest.yaml');
    if (!existsSync(file)) continue;
    const m = parse(readFileSync(file, 'utf8')) as { path?: string; module?: number };
    if (m.path) out.push({ slug, path: m.path, module: m.module ?? 1 });
  }
  return out;
}

describe('packages/catalogue/paths.json', () => {
  const labs = placedLabs();

  it('has an entry for every path a lab is placed in, and no path without labs', () => {
    const used = new Set(labs.map((l) => l.path));
    const described = new Set(meta.paths.map((p) => p.slug));
    expect([...used].filter((p) => !described.has(p))).toEqual([]);
    expect([...described].filter((p) => !used.has(p))).toEqual([]);
  });

  it('has an entry for every module a lab uses in a multi-module path', () => {
    for (const path of meta.paths) {
      const moduleNumbers = new Set(labs.filter((l) => l.path === path.slug).map((l) => l.module));
      if (path.modules.length === 0) {
        // A single-module path: its labs must all sit in module 1.
        expect([...moduleNumbers], `${path.slug} has no module entries, so its labs must be in module 1`).toEqual([1]);
        continue;
      }
      const described = new Set(path.modules.map((m) => m.number));
      expect([...moduleNumbers].filter((n) => !described.has(n)), `${path.slug}: modules used by labs but not described`).toEqual([]);
      expect([...described].filter((n) => !moduleNumbers.has(n)), `${path.slug}: modules described but with no labs`).toEqual([]);
    }
  });

  it('keeps every intro readable: present, one paragraph, under 420 characters, no markup', () => {
    const texts: [string, string][] = [];
    for (const p of meta.paths) {
      texts.push([p.slug, p.intro]);
      for (const m of p.modules) texts.push([`${p.slug}#${m.number}`, m.intro]);
    }
    for (const [where, text] of texts) {
      expect(text.length, `${where} intro length`).toBeGreaterThan(40);
      expect(text.length, `${where} intro length`).toBeLessThanOrEqual(420);
      expect(text, `${where} intro must be plain text`).not.toMatch(/[<>]|\n/);
    }
  });

  it('gives each module two to four short outcomes and a unique number within its path', () => {
    for (const p of meta.paths) {
      const numbers = p.modules.map((m) => m.number);
      expect(new Set(numbers).size, `${p.slug} module numbers are unique`).toBe(numbers.length);
      for (const m of p.modules) {
        expect(m.outcomes.length, `${p.slug}#${m.number} outcomes`).toBeGreaterThanOrEqual(2);
        expect(m.outcomes.length, `${p.slug}#${m.number} outcomes`).toBeLessThanOrEqual(4);
        for (const s of m.outcomes) expect(s.length, `${p.slug}#${m.number} outcome "${s}"`).toBeLessThanOrEqual(60);
      }
    }
  });

  it('names the accent from a fixed set the design maps to tokens', () => {
    const allowed = new Set(['blue', 'teal', 'green', 'amber', 'rose', 'violet', 'indigo', 'slate']);
    for (const p of meta.paths) {
      expect(allowed.has(p.accent), `${p.slug} accent ${p.accent}`).toBe(true);
      for (const m of p.modules) expect(allowed.has(m.accent), `${p.slug}#${m.number} accent ${m.accent}`).toBe(true);
    }
  });
});
