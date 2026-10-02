import type { LabState } from './derive';
import { difficultyOf } from './scoring';
import type { Difficulty, XpLevel } from './types';

/**
 * XP is a pure function of facts: it is recomputed from the completed labs
 * every time, never incremented, so replaying or recomputing can never
 * double-count.
 *
 * A completed lab earns its difficulty's base, plus 25 when no hint had
 * unlocked in the completing session, plus 25 when the very first run of the
 * lab passed. Only the first completion of a lab counts.
 */

export const BASE_XP: Record<Difficulty, number> = { intro: 50, core: 100, advanced: 150 };
export const NO_HINT_BONUS = 25;
export const FIRST_TRY_BONUS = 25;

export function completionXp(difficulty: Difficulty, c: { no_hints: boolean; first_try: boolean }): number {
  return BASE_XP[difficulty] + (c.no_hints ? NO_HINT_BONUS : 0) + (c.first_try ? FIRST_TRY_BONUS : 0);
}

/** Total XP over the completed labs. Unmapped labs count; archived and unlisted ones are never in `states`. */
export function totalXp(states: readonly Pick<LabState, 'lab' | 'completion'>[]): number {
  let xp = 0;
  for (const s of states) if (s.completion) xp += completionXp(difficultyOf(s.lab), s.completion);
  return xp;
}

/** `at` is the total XP at which the level starts. */
export const XP_LEVELS: ReadonlyArray<{ n: number; title: string; at: number }> = [
  { n: 1, title: 'Newcomer', at: 0 },
  { n: 2, title: 'Explorer', at: 100 },
  { n: 3, title: 'Apprentice', at: 250 },
  { n: 4, title: 'Builder', at: 500 },
  { n: 5, title: 'Engineer', at: 850 },
  { n: 6, title: 'Specialist', at: 1300 },
  { n: 7, title: 'Architect', at: 1900 },
  { n: 8, title: 'Mentor', at: 2600 },
  { n: 9, title: 'Master', at: 3500 },
  { n: 10, title: 'Legend', at: 4600 },
];

/** The level for a total XP, how far into it the learner is, and how wide the level is (0 at the top). */
export function xpLevel(xp: number): XpLevel {
  const safe = Math.max(0, Math.floor(xp));
  let idx = 0;
  XP_LEVELS.forEach((l, i) => {
    if (safe >= l.at) idx = i;
  });
  const current = XP_LEVELS[idx]!;
  const next = XP_LEVELS[idx + 1];
  return { n: current.n, title: current.title, xp_into: safe - current.at, xp_needed: next ? next.at - current.at : 0 };
}
