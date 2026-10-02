import type { CatalogueLab, ProfileFacts, RunFact, SessionFact } from '../../src/profile/types';

/** Tue 2026-01-06 12:00:00 UTC, an arbitrary fixed "now" so no test reads the clock. */
export const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);
export const MIN = 60_000;
export const DAY = 86_400_000;

let seq = 0;

/** A catalogue lab; by default a core lab in module 1 of ai-platform (the gateway area). */
export function lab(slug: string, extra: Partial<CatalogueLab> = {}): CatalogueLab {
  return { slug, title: `Lab ${slug}`, path: 'ai-platform', module: 1, order: 1, difficulty: 'core', ...extra };
}

/** A finished run. A score of 1 passes everything unless `passed_all` says otherwise. */
export function run(lab_slug: string, extra: Partial<RunFact> = {}): RunFact {
  const started_at = extra.started_at ?? NOW - DAY;
  const score = extra.score ?? 1;
  return {
    run_id: `r${String(++seq).padStart(5, '0')}`,
    session_id: `s-${lab_slug}`,
    lab_slug,
    started_at,
    finished_at: started_at + 1000,
    score,
    passed_all: score === 1,
    ...extra,
  };
}

export function session(id: string, lab_slug: string, extra: Partial<SessionFact> = {}): SessionFact {
  return { id, lab_slug, created_at: NOW - 2 * DAY, started_at: NOW - 2 * DAY, hints_delivered: 0, ...extra };
}

export function facts(extra: Partial<ProfileFacts> = {}): ProfileFacts {
  return { user_id: 'u1', now: NOW, runs: [], sessions: [], earned: [], ...extra };
}

/** `n` labs `lab-1..lab-n` in module `module` of ai-platform, in order. */
export function labs(n: number, module = 1, extra: Partial<CatalogueLab> = {}): CatalogueLab[] {
  return Array.from({ length: n }, (_, i) => lab(`m${module}-lab-${i + 1}`, { module, order: i + 1, ...extra }));
}
