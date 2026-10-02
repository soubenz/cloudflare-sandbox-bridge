import type { LabIndexEntry } from '../labs/bundle';
import { prerequisitesIn, stableTopo } from './rules';

/**
 * The server's check on a model's ordering. The model is a suggestion and
 * never an authority: whatever it returns, the path is exactly the labs the
 * rules allowed, each once, and no lab precedes a prerequisite.
 *
 * `proposed` is the model's slugs in its order. The result is built from the
 * `allowed` entries (the rules' own order), so a hallucinated slug cannot
 * become a step:
 *
 *  - unknown slugs (not in the allowed set) are dropped;
 *  - duplicates keep their first position;
 *  - allowed labs the model left out are appended in rules order;
 *  - a lab placed before one of its prerequisites is moved to just after it
 *    (stable topological fix-up; see `stableTopo`).
 */
export function fixOrder(proposed: readonly string[], allowed: readonly LabIndexEntry[]): LabIndexEntry[] {
  const bySlug = new Map(allowed.map((l) => [l.slug, l]));
  const seen = new Set<string>();
  const kept: LabIndexEntry[] = [];
  for (const slug of proposed) {
    const lab = bySlug.get(slug);
    if (!lab || seen.has(slug)) continue;
    seen.add(slug);
    kept.push(lab);
  }
  for (const lab of allowed) if (!seen.has(lab.slug)) kept.push(lab);
  const inSet = new Set(bySlug.keys());
  return stableTopo(
    kept,
    (l) => l.slug,
    (l) => prerequisitesIn(l, inSet)
  );
}
