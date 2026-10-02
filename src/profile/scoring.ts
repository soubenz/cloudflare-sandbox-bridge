import type { BestResult, LabState } from './derive';
import type { CatalogueLab, Difficulty, SkillLevel } from './types';

/**
 * Skill scores. All constants are here so a change to the rules is one edit
 * and one test.
 *
 * A lab's score (0-100):
 *   raw      = best run's share of check weight passed, x 100
 *   hinted   = max(raw x 0.6, raw - 5 x hints)       each hint costs 5 points, never below 60% of raw
 *   factor   = max(0.8, 1 - 0.03 x (attempts - 1))   first try is full; 3% per extra run, floor 80%
 *   lab      = hinted x factor
 * `hints` and `attempts` are those of the best run (its session's hints, and
 * how many runs of the lab it took to get there).
 *
 * An area's score is the difficulty-weighted average of its labs' scores over
 * ALL the area's non-archived labs, an unattempted lab counting as 0
 * (intro 1, core 2, advanced 3), rounded to a whole number.
 */

export const DIFFICULTY_WEIGHT: Record<Difficulty, number> = { intro: 1, core: 2, advanced: 3 };
export const HINT_PENALTY_POINTS = 5;
export const HINT_FLOOR = 0.6;
export const ATTEMPT_PENALTY = 0.03;
export const ATTEMPT_FLOOR = 0.8;

/** A lab with no declared difficulty is treated as `core`. */
export function difficultyOf(lab: Pick<CatalogueLab, 'difficulty'>): Difficulty {
  return lab.difficulty ?? 'core';
}

/** Score of one lab, 0-100, unrounded. A lab never attempted is 0. */
export function labScore(best: BestResult | null): number {
  if (!best) return 0;
  const hinted = Math.max(best.score * HINT_FLOOR, best.score - HINT_PENALTY_POINTS * best.hints);
  const factor = Math.max(ATTEMPT_FLOOR, 1 - ATTEMPT_PENALTY * (Math.max(1, best.attempts) - 1));
  return hinted * factor;
}

/** Whole-number score; anything above zero shows as at least 1 so a started area never reads "Not started". */
function toScore(value: number): number {
  if (value <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round(value)));
}

/** The weighted average of an area's labs, 0-100. No labs is 0. */
export function areaScore(states: readonly Pick<LabState, 'lab' | 'best'>[]): number {
  let weighted = 0;
  let weights = 0;
  for (const s of states) {
    const w = DIFFICULTY_WEIGHT[difficultyOf(s.lab)];
    weighted += w * labScore(s.best);
    weights += w;
  }
  return weights === 0 ? 0 : toScore(weighted / weights);
}

/** Overall score: the mean of the area scores. */
export function overallScore(areaScores: readonly number[]): number {
  if (areaScores.length === 0) return 0;
  return toScore(areaScores.reduce((a, b) => a + b, 0) / areaScores.length);
}

/** Level names by score: 0 Not started, 1-29 Foundations, 30-59 Practitioner, 60-84 Proficient, 85-100 Expert. */
export function skillLevel(score: number): SkillLevel {
  if (score >= 85) return 'Expert';
  if (score >= 60) return 'Proficient';
  if (score >= 30) return 'Practitioner';
  if (score >= 1) return 'Foundations';
  return 'Not started';
}
