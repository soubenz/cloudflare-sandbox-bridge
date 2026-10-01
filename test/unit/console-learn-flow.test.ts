import { describe, it, expect } from 'vitest';

/**
 * The order of "Before you begin" (dashboard/src/learn-flow.js): story, then alternating rounds of
 * questions and chunks of lessons. Pure module, imported directly.
 */
type Q = { id: string; concept: string; diagnostic?: boolean };
type Concept = { id: string; title: string };
type Learn = { story?: { title: string }; comic?: { title: string }; concepts: Concept[]; questions: Q[] };
type Step =
  | { kind: 'story' }
  | { kind: 'round'; round: number; rounds: number; questions: string[] }
  | { kind: 'lessons'; part: number; parts: number; concepts: string[]; plan: Array<{ concept: string; state: string }> };
type Mastery = { v?: number; onboarding?: { status: string | null; at: number; levels: Record<string, string> }; concepts?: Record<string, { known: boolean }>; overrides?: Record<string, string> };
const f = (await import('../../dashboard/src/learn-flow.js' as string)) as {
  ROUND_SIZE: number;
  MAX_ROUND: number;
  roundCaps: (total: number) => number[];
  chunkSizes: (n: number, chunks: number) => number[];
  planLearningFlow: (learn: Learn, mastery?: Mastery) => Step[];
  stepLabel: (step: Step, learn?: Learn) => string;
  questionHeading: (step: Step, index: number) => string;
  stepIndexFor: (steps: Step[], kind?: string, n?: number | null) => number;
  stepKindWord: (step: Step) => string;
  stepNumberFor: (steps: Step[], index: number) => number | null;
  restoreSteps: (learn: Learn, saved: unknown) => Step[] | null;
  createFlowStore: (o: { slug: string; version?: string; storage?: unknown }) => {
    load: () => { steps: Step[]; answers: Record<string, unknown> } | null;
    save: (steps: Step[], answers: Record<string, unknown>) => void;
    clear: () => void;
  };
};

/** A lab of `lessons` concepts (lesson-1 is the foundation) with `perConcept[i]` questions each; `falseAt` lists question ids that are not diagnostic. */
function lab(perConcept: number[], { story = true, falseAt = [] as string[] } = {}): Learn {
  const concepts = perConcept.map((_, i) => ({ id: `gateway.lesson-${i + 1}`, title: `Lesson ${i + 1}` }));
  const questions: Q[] = [];
  perConcept.forEach((n, i) => {
    for (let k = 1; k <= n; k++) {
      const id = `q${i + 1}-${k}`;
      questions.push({ id, concept: concepts[i]!.id, ...(falseAt.includes(id) ? { diagnostic: false } : { diagnostic: true }) });
    }
  });
  return { ...(story ? { story: { title: 'The story' } } : {}), concepts, questions };
}
const kinds = (steps: Step[]) => steps.map((s) => s.kind);
const rounds = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: 'round' }> => s.kind === 'round');
const lessons = (steps: Step[]) => steps.filter((s): s is Extract<Step, { kind: 'lessons' }> => s.kind === 'lessons');
const asked = (steps: Step[]) => rounds(steps).flatMap((r) => r.questions);
const NONE: Mastery = {};

describe('roundCaps', () => {
  it('is fives, with a tiny last round folded in and the rounds evened out (never more than 6)', () => {
    expect(f.roundCaps(0)).toEqual([]);
    expect(f.roundCaps(4)).toEqual([6]);
    expect(f.roundCaps(5)).toEqual([6]);
    expect(f.roundCaps(6)).toEqual([6]);
    expect(f.roundCaps(10)).toEqual([5, 6]);
    expect(f.roundCaps(15)).toEqual([5, 5, 6]);
    for (let total = 1; total <= 60; total++) {
      const caps = f.roundCaps(total);
      expect(Math.max(...caps)).toBeLessThanOrEqual(f.MAX_ROUND);
      // Enough room for every question, and no round (but the last, which takes leftovers) over five unless folded.
      expect(caps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(total);
    }
  });

  it('folds 1 or 2 questions left over into the other rounds: 11 is 6 and 5, 12 is 6 and 6, 16 is 6, 5, 5', () => {
    expect(f.roundCaps(11).slice(0, -1)).toEqual([6]);
    expect(f.roundCaps(12).slice(0, -1)).toEqual([6]);
    expect(f.roundCaps(11)).toHaveLength(2);
    expect(f.roundCaps(12)).toHaveLength(2);
    expect(f.roundCaps(16)).toHaveLength(3);
    expect(f.roundCaps(16).slice(0, -1)).toEqual([6, 5]);
    expect(f.roundCaps(17)).toHaveLength(3);
    expect(f.roundCaps(6)).toHaveLength(1);
  });

  it('keeps 7 as two rounds (4 and 3): folding two into one round of 5 would be 7', () => {
    expect(f.roundCaps(7)).toHaveLength(2);
    expect(f.roundCaps(7)[0]).toBe(4);
  });
});

describe('chunkSizes', () => {
  it('spreads lessons as evenly as it can, the earlier chunks the longer', () => {
    expect(f.chunkSizes(5, 2)).toEqual([3, 2]);
    expect(f.chunkSizes(4, 1)).toEqual([4]);
    expect(f.chunkSizes(6, 3)).toEqual([2, 2, 2]);
    expect(f.chunkSizes(2, 5)).toEqual([1, 1]);
    expect(f.chunkSizes(0, 2)).toEqual([]);
    expect(f.chunkSizes(5, 0)).toEqual([]);
  });
});

describe('planLearningFlow', () => {
  it('15 questions and 5 lessons: story, round 1, lessons A, round 2, lessons B, round 3', () => {
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), NONE);
    expect(kinds(steps)).toEqual(['story', 'round', 'lessons', 'round', 'lessons', 'round']);
    expect(rounds(steps).map((r) => [r.round, r.rounds, r.questions.length])).toEqual([
      [1, 3, 5],
      [2, 3, 5],
      [3, 3, 5],
    ]);
    expect(lessons(steps).map((l) => [l.part, l.parts, l.concepts.length])).toEqual([
      [1, 2, 3],
      [2, 2, 2],
    ]);
    // Every question exactly once.
    expect(asked(steps).sort()).toEqual(lab([3, 3, 3, 3, 3]).questions.map((q) => q.id).sort());
  });

  it('round 1 takes one question of each concept in lesson order (the foundation first), then goes round again', () => {
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), NONE);
    const first = rounds(steps)[0]!.questions;
    expect(first).toEqual(['q1-1', 'q2-1', 'q3-1', 'q4-1', 'q5-1']);
    const six = f.planLearningFlow(lab([3, 3, 3]), NONE);
    expect(rounds(six)[0]!.questions).toEqual(['q1-1', 'q2-1', 'q3-1', 'q1-2', 'q2-2']);
  });

  it('each later round asks about the lessons just read, then the leftovers go to the last round', () => {
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), NONE);
    const [, second, third] = rounds(steps);
    const chunkA = new Set(['gateway.lesson-1', 'gateway.lesson-2', 'gateway.lesson-3']);
    const conceptOf = (id: string) => `gateway.lesson-${id.slice(1, id.indexOf('-'))}`;
    // Round 2 is all about chunk A's concepts (and none of what round 1 asked).
    expect(second!.questions.every((id) => chunkA.has(conceptOf(id)))).toBe(true);
    expect(second!.questions).toHaveLength(5);
    // Round 3 holds chunk B's remaining questions plus the one chunk A left.
    const inB = third!.questions.filter((id) => !chunkA.has(conceptOf(id)));
    expect(inB).toHaveLength(4);
    expect(third!.questions.filter((id) => chunkA.has(conceptOf(id)))).toHaveLength(1);
  });

  it('12 questions and 4 lessons: 6 and 6, so one lessons chunk between two rounds', () => {
    const steps = f.planLearningFlow(lab([3, 3, 3, 3]), NONE);
    expect(kinds(steps)).toEqual(['story', 'round', 'lessons', 'round']);
    expect(rounds(steps).map((r) => r.questions.length)).toEqual([6, 6]);
    expect(lessons(steps)[0]!.concepts).toHaveLength(4);
    expect(new Set(asked(steps)).size).toBe(12);
  });

  it('a lab with 5 questions or fewer asks one round, then shows all its lessons as one chunk', () => {
    for (const n of [1, 3, 4, 5]) {
      const steps = f.planLearningFlow(lab([n, 0, 0]), NONE);
      expect(kinds(steps)).toEqual(['story', 'round', 'lessons']);
      expect(rounds(steps)[0]!.questions).toHaveLength(n);
      expect(rounds(steps)[0]).toMatchObject({ round: 1, rounds: 1 });
      expect(lessons(steps)[0]).toMatchObject({ part: 1, parts: 1 });
      expect(lessons(steps)[0]!.concepts).toHaveLength(3);
    }
    const four = f.planLearningFlow(lab([2, 1, 1]), NONE);
    expect(kinds(four)).toEqual(['story', 'round', 'lessons']);
  });

  it('a lab with no questions is story, lessons; with neither it is the story alone; with no story it starts at round 1', () => {
    expect(kinds(f.planLearningFlow(lab([0, 0, 0]), NONE))).toEqual(['story', 'lessons']);
    expect(kinds(f.planLearningFlow(lab([0, 0, 0], { story: false }), NONE))).toEqual(['lessons']);
    expect(kinds(f.planLearningFlow({ story: { title: 'x' }, concepts: [], questions: [] }, NONE))).toEqual(['story']);
    expect(f.planLearningFlow({ concepts: [], questions: [] }, NONE)).toEqual([]);
    expect(kinds(f.planLearningFlow(lab([3, 3, 3, 3, 3], { story: false }), NONE))).toEqual(['round', 'lessons', 'round', 'lessons', 'round']);
    // A comic counts as a story.
    expect(kinds(f.planLearningFlow({ comic: { title: 'c' }, concepts: [{ id: 'gateway.a', title: 'A' }], questions: [] }, NONE))).toEqual(['story', 'lessons']);
  });

  it('a lab with questions and no lessons is rounds only', () => {
    const learn: Learn = { story: { title: 's' }, concepts: [], questions: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, concept: 'gateway.x', diagnostic: true })) };
    const steps = f.planLearningFlow(learn, NONE);
    expect(kinds(steps)).toEqual(['story', 'round', 'round']);
    expect(rounds(steps).map((r) => r.questions.length)).toEqual([6, 6]);
  });

  it('the foundation lesson (first in the bundle) is in the first chunk, and lessons keep their order across chunks', () => {
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), NONE);
    const ids = lessons(steps).flatMap((l) => l.concepts);
    expect(ids).toEqual(['gateway.lesson-1', 'gateway.lesson-2', 'gateway.lesson-3', 'gateway.lesson-4', 'gateway.lesson-5']);
    expect(lessons(steps)[0]!.concepts[0]).toBe('gateway.lesson-1');
  });

  it('never asks a question twice, whatever the shape', () => {
    for (const per of [[1], [3, 3], [2, 2, 2, 2], [5, 5, 5], [1, 0, 7, 2], [4, 4, 4, 4, 4, 4], [9, 9], [2, 0, 0, 0, 0, 0, 0]]) {
      const steps = f.planLearningFlow(lab(per), NONE);
      const ids = asked(steps);
      expect(new Set(ids).size, JSON.stringify(per)).toBe(ids.length);
      for (const r of rounds(steps)) expect(r.questions.length).toBeLessThanOrEqual(f.MAX_ROUND);
      expect(ids.length).toBeLessThanOrEqual(per.reduce((a, b) => a + b, 0));
    }
  });

  it('a question that is not diagnostic is asked after its lesson, in a later round', () => {
    const learn = lab([3, 3, 3, 3, 3], { falseAt: ['q1-3', 'q5-3'] });
    const steps = f.planLearningFlow(learn, NONE);
    expect(rounds(steps)[0]!.questions).not.toContain('q1-3');
    expect(rounds(steps)[0]!.questions).not.toContain('q5-3');
    expect(asked(steps)).toContain('q1-3');
    expect(asked(steps)).toContain('q5-3');
    // Round 1 holds only diagnostic questions.
    const diag = new Set(learn.questions.filter((q) => q.diagnostic !== false).map((q) => q.id));
    expect(rounds(steps)[0]!.questions.every((id) => diag.has(id))).toBe(true);
  });

  it('in a lab asked in a single round the questions that are not diagnostic come along (there is no later round)', () => {
    const steps = f.planLearningFlow(lab([2, 1, 1], { falseAt: ['q1-2'] }), NONE);
    expect(rounds(steps)).toHaveLength(1);
    expect(rounds(steps)[0]!.questions).toHaveLength(4);
    expect(rounds(steps)[0]!.questions).toContain('q1-2');
  });

  it('does not ask about a concept the learner already knows, and its lesson still comes (folded)', () => {
    const known: Mastery = { concepts: { 'gateway.lesson-2': { known: true } } };
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), known);
    expect(asked(steps).some((id) => id.startsWith('q2-'))).toBe(false);
    expect(asked(steps)).toHaveLength(12);
    const plan = lessons(steps).flatMap((l) => l.plan);
    expect(plan.find((p) => p.concept === 'gateway.lesson-2')!.state).toBe('collapsed');
    expect(plan.find((p) => p.concept === 'gateway.lesson-1')!.state).toBe('expanded');
  });

  it("a 'strong' platform area still folds its lessons when the lab asks nothing", () => {
    const strong: Mastery = { onboarding: { status: 'done', at: 1, levels: { gateway: 'strong' } } };
    const steps = f.planLearningFlow(lab([0, 0]), strong);
    expect(kinds(steps)).toEqual(['story', 'lessons']);
    expect(lessons(steps)[0]!.plan.map((p) => p.state)).toEqual(['collapsed', 'collapsed']);
    // With questions to ask, a diagnostic still beats the strong level: the questions are asked.
    const asking = f.planLearningFlow(lab([2, 2]), strong);
    expect(asked(asking)).toHaveLength(4);
  });

  it('skips a round that would be empty and joins the lessons either side of it', () => {
    // Chunk B (lessons 4 and 5) is all known: its round has nothing to ask.
    const known: Mastery = { concepts: { 'gateway.lesson-4': { known: true }, 'gateway.lesson-5': { known: true } } };
    const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), known);
    expect(rounds(steps).every((r) => r.questions.length > 0)).toBe(true);
    const parts = lessons(steps);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.kind === 'lessons' && steps[i - 1]!.kind === 'lessons').toBe(false);
    expect(parts.flatMap((l) => l.concepts)).toHaveLength(5);
    expect(parts.map((l) => [l.part, l.parts])).toEqual(parts.map((_, i) => [i + 1, parts.length]));
    expect(rounds(steps).map((r) => [r.round, r.rounds])).toEqual(rounds(steps).map((_, i) => [i + 1, rounds(steps).length]));

    const everything: Mastery = { concepts: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`gateway.lesson-${i}`, { known: true }])) };
    expect(kinds(f.planLearningFlow(lab([3, 3, 3, 3, 3]), everything))).toEqual(['story', 'lessons']);
  });

  it('has fewer lessons than rounds: the rounds that have no lessons of their own follow the last chunk', () => {
    const steps = f.planLearningFlow(lab([15]), NONE);
    expect(kinds(steps)).toEqual(['story', 'round', 'lessons', 'round', 'round']);
    expect(asked(steps)).toHaveLength(15);
  });

  it('is deterministic, and does not change its inputs', () => {
    const learn = lab([3, 3, 3, 3, 3], { falseAt: ['q2-3'] });
    const before = JSON.stringify(learn);
    const a = f.planLearningFlow(learn, NONE);
    const b = f.planLearningFlow(learn, NONE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(learn)).toBe(before);
    // The steps are plain data.
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('copes with a missing bundle or mastery', () => {
    expect(f.planLearningFlow(undefined as unknown as Learn)).toEqual([]);
    expect(kinds(f.planLearningFlow(lab([2, 2]), undefined))).toEqual(['story', 'round', 'lessons']);
  });
});

describe('reading the steps', () => {
  const steps = f.planLearningFlow(lab([3, 3, 3, 3, 3]), NONE);

  it('names a step for a screen reader and a question for its heading', () => {
    expect(f.stepLabel(steps[0]!, { story: { title: 'Monday at Larkfield' }, concepts: [], questions: [] })).toBe('Monday at Larkfield');
    expect(f.stepLabel(steps[1]!)).toBe('Questions, round 1 of 3');
    expect(f.stepLabel(steps[2]!)).toBe('Lessons, part 1 of 2');
    expect(f.questionHeading(steps[3]!, 2)).toBe('Round 2 of 3 · question 3 of 5');
    const single = f.planLearningFlow(lab([4, 0]), NONE);
    expect(f.stepLabel(single[1]!)).toBe('Questions');
    expect(f.stepLabel(single[2]!)).toBe('Lessons');
    expect(f.questionHeading(single[1]!, 0)).toBe('Question 1 of 4');
  });

  it('finds the step an address names: a number in range wins, out of range is the first step, a word is the first of its kind', () => {
    expect(f.stepIndexFor(steps, 'story')).toBe(0);
    expect(f.stepIndexFor(steps, 'questions')).toBe(1);
    expect(f.stepIndexFor(steps, 'lessons')).toBe(2);
    expect(f.stepIndexFor(steps, 'questions', 4)).toBe(3);
    expect(f.stepIndexFor(steps, 'lessons', 5)).toBe(4);
    expect(f.stepIndexFor(steps, 'story', 6)).toBe(5);
    // The number wins over a word that does not match it.
    expect(f.stepIndexFor(steps, 'story', 4)).toBe(3);
    // Out of range, zero, negative, fractional: the first step.
    for (const n of [7, 99, 0, -1, 2.5]) expect(f.stepIndexFor(steps, 'lessons', n)).toBe(0);
    expect(f.stepIndexFor(steps, undefined, undefined)).toBe(0);
    expect(f.stepIndexFor([], 'lessons', 3)).toBe(0);
    // A kind the lab does not have falls to the closest one it does.
    const noQuestions = f.planLearningFlow(lab([0, 0]), NONE);
    expect(f.stepIndexFor(noQuestions, 'questions')).toBe(1);
    const noStory = f.planLearningFlow(lab([2, 2], { story: false }), NONE);
    expect(f.stepIndexFor(noStory, 'story')).toBe(0);
  });

  it('numbers a step in the address only when its word alone would not mean it', () => {
    expect(steps.map((_, i) => f.stepNumberFor(steps, i))).toEqual([null, null, null, 4, 5, 6]);
    expect(steps.map((s) => f.stepKindWord(s))).toEqual(['story', 'questions', 'lessons', 'questions', 'lessons', 'questions']);
    // Each number leads back to its own step.
    steps.forEach((s, i) => expect(f.stepIndexFor(steps, f.stepKindWord(s), f.stepNumberFor(steps, i) ?? undefined)).toBe(i));
  });
});

describe('restoreSteps and the flow store', () => {
  const learn = lab([3, 3, 3, 3, 3]);
  const steps = f.planLearningFlow(learn, NONE);

  it('takes saved steps back when everything they name still exists, and refuses them otherwise', () => {
    expect(f.restoreSteps(learn, JSON.parse(JSON.stringify(steps)))).toEqual(steps);
    expect(f.restoreSteps(learn, [])).toBeNull();
    expect(f.restoreSteps(learn, null)).toBeNull();
    expect(f.restoreSteps(learn, [{ kind: 'round', round: 1, rounds: 1, questions: ['gone'] }])).toBeNull();
    expect(f.restoreSteps(learn, [{ kind: 'lessons', part: 1, parts: 1, concepts: ['gateway.gone'], plan: [] }])).toBeNull();
    expect(f.restoreSteps(learn, [{ kind: 'nope' }])).toBeNull();
    expect(f.restoreSteps(learn, ['x'])).toBeNull();
  });

  const memory = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
  };

  it('keeps one lab visit: the plan and the answers, for the same bundle version', () => {
    const storage = memory();
    const a = f.createFlowStore({ slug: 'lab-a', version: '1.0.0', storage });
    expect(a.load()).toBeNull();
    a.save(steps, { 'q1-1': { question_id: 'q1-1', concept: 'gateway.lesson-1', correct: true, selected: ['a'] } });
    const got = a.load()!;
    expect(got.steps).toEqual(steps);
    expect(Object.keys(got.answers)).toEqual(['q1-1']);
    // Another version, another lab: nothing.
    expect(f.createFlowStore({ slug: 'lab-a', version: '1.0.1', storage }).load()).toBeNull();
    expect(f.createFlowStore({ slug: 'lab-b', version: '1.0.0', storage }).load()).toBeNull();
    a.clear();
    expect(a.load()).toBeNull();
  });

  it('survives storage that throws or holds rubbish', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const s = f.createFlowStore({ slug: 'x', version: '1', storage: broken });
    expect(s.load()).toBeNull();
    expect(() => s.save(steps, {})).not.toThrow();
    expect(() => s.clear()).not.toThrow();
    const storage = memory();
    storage.setItem('opalix.flow.x', '{not json');
    expect(f.createFlowStore({ slug: 'x', version: '1', storage }).load()).toBeNull();
    storage.setItem('opalix.flow.x', JSON.stringify({ v: 2, version: '1', steps: [] }));
    expect(f.createFlowStore({ slug: 'x', version: '1', storage }).load()).toBeNull();
    expect(f.createFlowStore({ slug: 'x', version: '1', storage: null }).load()).toBeNull();
  });
});
