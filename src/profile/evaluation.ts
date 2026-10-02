import type { SkillLevel } from './types';

/**
 * Plain-language evaluation text. Rule based and deterministic: the same
 * inputs always give the same words, and nothing here calls a model. The
 * sentences are written for a learner, so they talk about labs, hints and
 * attempts and never about how any of it is stored or computed.
 */

export interface AreaEvaluationInput {
  title: string;
  level: SkillLevel;
  labsDone: number;
  labsTotal: number;
  /** The learner has run at least one lab of this area. */
  attempted: boolean;
  /** Title of the next lab to do in this area, by catalogue order. */
  nextLab: string | null;
  /** A finished lab in this area used a hint. */
  usedHints: boolean;
  /** A finished lab in this area took more than one attempt. */
  retried: boolean;
}

const q = (title: string) => `"${title}"`;

export function evaluateArea(i: AreaEvaluationInput): string {
  if (i.labsTotal === 0) return `There are no labs in ${i.title} yet. Check back soon.`;
  if (!i.attempted) {
    return `You have not started ${i.title} yet.${i.nextLab ? ` A good place to begin is ${q(i.nextLab)}.` : ''}`;
  }

  const progress = `${i.labsDone} of ${i.labsTotal} ${i.labsTotal === 1 ? 'lab' : 'labs'} finished`;
  let strength: string;
  switch (i.level) {
    case 'Expert':
      strength = `You have a strong command of ${i.title}: ${progress}, with excellent results.`;
      break;
    case 'Proficient':
      strength = `You are confident in ${i.title}: ${progress}, with strong results.`;
      break;
    case 'Practitioner':
      strength = `You can work through ${i.title} on your own: ${progress}.`;
      break;
    case 'Foundations':
      strength = `You have made a start in ${i.title}: ${progress}.`;
      break;
    default:
      strength = `You have had a first go at ${i.title}, but no lab is passing yet.`;
  }

  if (!i.nextLab) return `${strength} You have finished every lab here.`;

  let next = `Next up: ${q(i.nextLab)}.`;
  if (i.level !== 'Expert') {
    if (i.usedHints) next += ' Try it without hints to raise your score.';
    else if (i.retried) next += ' Passing on your first attempt will raise your score.';
  }
  return `${strength} ${next}`;
}

export interface OverallEvaluationInput {
  level: SkillLevel;
  attempted: boolean;
  areas: ReadonlyArray<{ title: string; score: number }>;
}

export function evaluateOverall(i: OverallEvaluationInput): string {
  if (!i.attempted) return 'You have not started any labs yet. Pick one to begin building your skills and earning points.';
  let strongest = i.areas[0];
  let weakest = i.areas[0];
  for (const a of i.areas) {
    if (strongest && a.score > strongest.score) strongest = a;
    if (weakest && a.score < weakest.score) weakest = a;
  }
  let text = `Overall you are at ${i.level} level.`;
  if (strongest && weakest && strongest.score > weakest.score) {
    text += ` Your strongest area is ${strongest.title}, and ${weakest.title} has the most room to grow.`;
  }
  return text;
}
