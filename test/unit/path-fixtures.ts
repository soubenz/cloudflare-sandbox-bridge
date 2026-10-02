import type { LabIndexEntry } from '../../src/labs/bundle';

/**
 * A small catalogue for the learning-path tests. Areas come from the real
 * packages/catalogue/concepts.json: gateway is ai-platform module 1, mcp is
 * module 2, rag is module 3. Slugs are short on purpose.
 */
export function lab(slug: string, extra: Partial<LabIndexEntry> = {}): LabIndexEntry {
  return {
    slug,
    version: '1.0.0',
    title: `Lab ${slug}`,
    type: 'build',
    family: 'gateway',
    objectives: [],
    timeout_minutes: 60,
    tier: 'pro',
    has_learn: false,
    ...extra,
  };
}

export const CATALOGUE: LabIndexEntry[] = [
  lab('gw-intro', { title: 'See what a gateway does', path: 'ai-platform', module: 1, order: 1, difficulty: 'intro', tier: 'free', estimated_minutes: 20 }),
  lab('gw-routing', { title: 'Add a model without touching app code', path: 'ai-platform', module: 1, order: 2, difficulty: 'core', prerequisites: ['gw-intro'], estimated_minutes: 30 }),
  lab('gw-capstone', { title: 'Hard budget per team', path: 'ai-platform', module: 1, order: 3, difficulty: 'advanced', prerequisites: ['gw-routing'], estimated_minutes: 45 }),
  lab('mcp-intro', { title: 'See how tools reach an agent', path: 'ai-platform', module: 2, order: 1, difficulty: 'intro', tier: 'free', estimated_minutes: 25 }),
  lab('mcp-virtual', { title: 'One endpoint for every tool', path: 'ai-platform', module: 2, order: 2, difficulty: 'core', prerequisites: ['mcp-intro'], tier: 'free', estimated_minutes: 35 }),
  lab('rag-basics', { title: 'See why a document matched', path: 'ai-platform', module: 3, order: 1, difficulty: 'intro', estimated_minutes: 30 }),
  lab('standalone', { title: 'Weekend bill', path: 'production-agents', module: 1, order: 1, tier: 'free', estimated_minutes: 40 }),
  lab('old-lab', { title: 'Retired', path: 'ai-platform', module: 1, order: 9, archived: true, tier: 'free' }),
];

export const slugs = (labs: readonly { slug: string }[]) => labs.map((l) => l.slug);
