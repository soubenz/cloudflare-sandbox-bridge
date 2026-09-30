import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearnBundleSchema, OnboardingQuestionSchema, QuestionSchema, checkLearnBundle, checkOnboarding, parseLearnBundle, parseOnboarding, KNOWN_CONCEPTS, type LearnBundle } from '../../src/labs/learn';
import registry from '../../packages/catalogue/concepts.json';
import { compileLearnDir, splitFrontMatter } from '../../cli/src/learn-compile';

const known = new Set(['gateway.routing-aliases', 'gateway.usage-and-spend']);

function bundle(over: Partial<LearnBundle> = {}): LearnBundle {
  return LearnBundleSchema.parse({
    version: 1,
    story: { title: 'Monday at Larkfield', minutes: 2, body: 'You start on Monday.\n\nMaren hands you a laptop.' },
    concepts: [
      { id: 'gateway.routing-aliases', title: 'Aliases', minutes: 2, recap: 'An alias maps a name to a model.', body: 'An alias is a stable name.' },
    ],
    questions: [
      {
        id: 'q-alias',
        concept: 'gateway.routing-aliases',
        type: 'single',
        prompt: 'What does an alias give callers?',
        options: [
          { id: 'a', text: 'A stable name' },
          { id: 'b', text: 'A faster model' },
        ],
        answer: ['a'],
        explanation: 'Callers keep one name while the model behind it changes.',
      },
    ],
    ...over,
  });
}

describe('learn bundle schema', () => {
  it('accepts a complete bundle and defaults diagnostic to true', () => {
    const b = bundle();
    expect(b.questions[0]!.diagnostic).toBe(true);
    expect(b.answers_file).toBe('answers.json');
    expect(checkLearnBundle(b, known)).toEqual([]);
  });

  it('rejects HTML and multi-line plain text', () => {
    expect(() => bundle({ concepts: [{ ...bundle().concepts[0]!, body: 'hello <script>x</script>' }] })).toThrow(/HTML/);
    expect(() => bundle({ concepts: [{ ...bundle().concepts[0]!, recap: 'two\nlines' }] })).toThrow();
  });

  it('enforces answer rules per question type', () => {
    const q = bundle().questions[0]!;
    expect(() => bundle({ questions: [{ ...q, answer: ['zzz'] }] })).toThrow(/not one of its options/);
    expect(() => bundle({ questions: [{ ...q, answer: ['a', 'b'] }] })).toThrow(/exactly one answer/);
    expect(() => bundle({ questions: [{ ...q, type: 'multi', answer: ['a'] }] })).toThrow(/two or more/);
    expect(() =>
      bundle({ questions: [{ ...q, type: 'multi', answer: ['a', 'b'] }] })
    ).toThrow(/not every option/);
  });

  it('requires a choice field to list its choices and only a choice field to', () => {
    const base = { key: 'k', prompt: 'p', kind: 'choice' as const };
    expect(() => bundle({ fields: [base] })).toThrow(/needs choices/);
    expect(() => bundle({ fields: [{ ...base, kind: 'text', choices: ['a', 'b'] }] })).toThrow(/only a choice field/);
    expect(bundle({ fields: [{ ...base, choices: ['a', 'b'] }] }).fields).toHaveLength(1);
  });
});

describe('checkLearnBundle', () => {
  it('flags a concept that is not in the registry', () => {
    expect(checkLearnBundle(bundle(), new Set())).toEqual([expect.stringContaining('not in packages/catalogue/concepts.json')]);
  });

  it('flags a question about a concept the lab has no lesson for', () => {
    const q = bundle().questions[0]!;
    const problems = checkLearnBundle(bundle({ questions: [q, { ...q, id: 'q-other', concept: 'gateway.usage-and-spend' }] }), known);
    expect(problems.join()).toMatch(/gateway.usage-and-spend.*no lesson/);
  });

  it('flags a lesson that no diagnostic question can skip', () => {
    const q = bundle().questions[0]!;
    expect(checkLearnBundle(bundle({ questions: [{ ...q, diagnostic: false }] }), known).join()).toMatch(/never be skipped/);
  });

  it('flags duplicate ids and duplicate field keys', () => {
    const b = bundle();
    const q = b.questions[0]!;
    expect(checkLearnBundle(bundle({ questions: [q, q] }), known).join()).toMatch(/same id/);
    const f = { key: 'k', prompt: 'p', kind: 'text' as const };
    expect(checkLearnBundle(bundle({ fields: [f, f] }), known).join()).toMatch(/same answers.json key/);
  });

  it('rejects an empty learn folder', () => {
    expect(checkLearnBundle(LearnBundleSchema.parse({ version: 1, concepts: [], questions: [] }), known).join()).toMatch(/no story/);
  });

  it('parseLearnBundle throws one error listing the problems', () => {
    expect(() => parseLearnBundle({ version: 1, concepts: [], questions: [{}] }, known)).toThrow(/Invalid learn bundle/);
  });
});

describe('the real concept registry', () => {
  it('has unique, well-formed ids', () => {
    const ids = [...KNOWN_CONCEPTS];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('compileLearnDir', () => {
  function labDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-learn-'));
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
    }
    return dir;
  }
  const GOOD: Record<string, string> = {
    'learn/story.md': '---\ntitle: Monday at Larkfield\nminutes: 2\n---\nYou start on Monday.\n',
    'learn/concepts/gateway.routing-aliases.md':
      '---\nid: gateway.routing-aliases\ntitle: Aliases\nminutes: 2\nrecap: An alias maps a name to a model.\n---\nAn alias is a stable name.\n',
    'learn/quiz.yaml': `questions:
  - id: q-alias
    concept: gateway.routing-aliases
    type: single
    prompt: What does an alias give callers?
    options:
      - { id: a, text: A stable name }
      - { id: b, text: A faster model }
    answer: [a]
    explanation: Callers keep one name while the model behind it changes.
`,
    'learn/questions.yaml': `answers_file: answers.json
fields:
  - { key: first, prompt: First?, kind: text }
  - { key: second, prompt: Second?, kind: number }
`,
    'workspace/answers.json': '{ "first": null, "second": null }',
  };

  it('returns null when there is no learn folder', () => {
    const dir = labDir({ 'manifest.yaml': 'slug: x\n' });
    try {
      expect(compileLearnDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compiles a good folder, including front matter and the answers file check', () => {
    const dir = labDir(GOOD);
    try {
      const r = compileLearnDir(dir)!;
      expect(r.problems).toEqual([]);
      expect(r.bundle!.story!.body).toBe('You start on Monday.');
      expect(r.bundle!.concepts[0]!.id).toBe('gateway.routing-aliases');
      expect(r.bundle!.fields.map((f) => f.key)).toEqual(['first', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a lesson whose id differs from its file name', () => {
    const dir = labDir({ ...GOOD, 'learn/concepts/gateway.routing-aliases.md': GOOD['learn/concepts/gateway.routing-aliases.md']!.replace('id: gateway.routing-aliases', 'id: gateway.usage-and-spend') });
    try {
      expect(compileLearnDir(dir)!.problems.join()).toMatch(/must equal the file name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports fields that do not match the answers file, in both directions', () => {
    const dir = labDir({ ...GOOD, 'workspace/answers.json': '{ "first": null, "third": null }' });
    try {
      const p = compileLearnDir(dir)!.problems.join('\n');
      expect(p).toMatch(/has key "third" but no field asks for it/);
      expect(p).toMatch(/field "second" is not a key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing answers file and invalid YAML without throwing', () => {
    const noAnswers = { ...GOOD };
    delete noAnswers['workspace/answers.json'];
    const a = labDir(noAnswers);
    const b = labDir({ ...GOOD, 'learn/quiz.yaml': 'questions: [unclosed' });
    try {
      expect(compileLearnDir(a)!.problems.join()).toMatch(/does not exist/);
      expect(compileLearnDir(b)!.problems.join()).toMatch(/not valid YAML/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('splits front matter and tolerates a file without it', () => {
    expect(splitFrontMatter('---\na: 1\n---\nbody\n')).toEqual({ data: { a: 1 }, body: 'body' });
    expect(splitFrontMatter('just text\n')).toEqual({ data: {}, body: 'just text' });
  });
});

describe('every lab that ships a learn/ folder', () => {
  const root = join(__dirname, '..', '..', 'labs');
  const withLearn = readdirSync(root).filter((s) => existsSync(join(root, s, 'learn')));

  it.each(withLearn.length > 0 ? withLearn : ['(none yet)'])('%s compiles with no problems', (slug) => {
    if (slug === '(none yet)') return;
    const r = compileLearnDir(join(root, slug))!;
    expect(r.problems).toEqual([]);
  });
});

describe('the onboarding quiz', () => {
  const file = join(__dirname, '..', '..', 'packages', 'catalogue', 'onboarding.json');
  const real = () => JSON.parse(readFileSync(file, 'utf8'));
  const areas = Object.keys(registry.areas);

  it('the shipped quiz validates', () => {
    expect(existsSync(file)).toBe(true);
    expect(() => parseOnboarding(real())).not.toThrow();
  });

  it('the shipped quiz has a blurb per area, at most 90 characters, and no claim about length or count', () => {
    const o = parseOnboarding(real());
    expect(o.areas.map((a) => a.area).sort()).toEqual([...areas].sort());
    for (const a of o.areas) expect(a.blurb.length).toBeLessThanOrEqual(90);
    expect(o.intro).not.toMatch(/\b\d+\s*(questions|minutes)\b/i);
    expect(o.intro).not.toMatch(/\b18\b|\b4 minutes\b/);
  });

  it('every area of the shipped quiz has at least one basic and one advanced question, and the file leads with the basic', () => {
    const o = parseOnboarding(real());
    for (const area of areas) {
      const mine = o.questions.filter((q) => q.concept.startsWith(area + '.'));
      expect(mine.filter((q) => q.level === 'basic').length, `${area} basic`).toBeGreaterThanOrEqual(1);
      expect(mine.filter((q) => q.level === 'advanced').length, `${area} advanced`).toBeGreaterThanOrEqual(1);
    }
  });

  /** The real quiz with `edit` applied to its questions, parsed with the schema only (checkOnboarding is run separately). */
  const withQuestions = (edit: (qs: any[]) => any[]) => ({ ...real(), questions: edit(real().questions) });

  it('requires a level on every onboarding question, and only basic or advanced', () => {
    expect(() => parseOnboarding(withQuestions((qs) => qs.map(({ level: _l, ...rest }) => rest)))).toThrow(/level/);
    expect(() => parseOnboarding(withQuestions((qs) => qs.map((q) => ({ ...q, level: 'expert' }))))).toThrow(/level/);
  });

  it('a lab quiz question has no level, and the level is not part of it', () => {
    const { level: _l, ...lab } = real().questions[0];
    expect(QuestionSchema.safeParse(lab).success).toBe(true);
    expect(OnboardingQuestionSchema.safeParse(lab).success).toBe(false);
    expect(OnboardingQuestionSchema.safeParse({ ...lab, level: 'basic' }).success).toBe(true);
    // The schema strips what it does not know, so a lab question never carries a level into a bundle.
    expect('level' in QuestionSchema.parse({ ...lab, level: 'basic' })).toBe(false);
  });

  it('an onboarding question keeps every rule of a lab question', () => {
    const bad = (over: Record<string, unknown>) => OnboardingQuestionSchema.safeParse({ ...real().questions[0], ...over }).success;
    expect(bad({ answer: ['zz'] })).toBe(false);
    expect(bad({ type: 'multi' })).toBe(false);
    expect(bad({ options: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] })).toBe(false);
  });

  it('rejects an area without a basic question, and one without an advanced question', () => {
    const noBasic = withQuestions((qs) => qs.map((q) => (q.concept.startsWith('rag.') ? { ...q, level: 'advanced' } : q)));
    expect(() => parseOnboarding(noBasic)).toThrow(/at least 1 basic question on "rag"/);
    const noAdvanced = withQuestions((qs) => qs.map((q) => (q.concept.startsWith('otel.') ? { ...q, level: 'basic' } : q)));
    expect(() => parseOnboarding(noAdvanced)).toThrow(/at least 1 advanced question on "otel"/);
  });

  it('rejects an area with no questions at all', () => {
    const noMcp = withQuestions((qs) => qs.filter((q) => !q.concept.startsWith('mcp.')));
    expect(() => parseOnboarding(noMcp)).toThrow(/"mcp"/);
  });

  it('accepts two questions per area (12 in all), and no fewer than that', () => {
    const twoEach = withQuestions((qs) => {
      const seen: Record<string, number> = {};
      return qs.filter((q) => {
        const key = `${q.concept.split('.')[0]}:${q.level}`;
        seen[key] = (seen[key] ?? 0) + 1;
        return seen[key] === 1;
      });
    });
    expect(twoEach.questions).toHaveLength(12);
    expect(() => parseOnboarding(twoEach)).not.toThrow();
    expect(() => parseOnboarding({ ...twoEach, questions: twoEach.questions.slice(0, 11) })).toThrow();
  });

  it('allows at most 24 questions', () => {
    const extra = Array.from({ length: 7 }, (_, i) => ({ ...real().questions[0], id: `ob-extra-${i}` }));
    expect(() => parseOnboarding({ ...real(), questions: [...real().questions, ...extra.slice(0, 6)] })).not.toThrow();
    expect(() => parseOnboarding({ ...real(), questions: [...real().questions, ...extra] })).toThrow();
  });

  it('keeps the old rules: known concept ids, unique ids', () => {
    const o = parseOnboarding(real());
    expect(checkOnboarding(o)).toEqual([]);
    expect(checkOnboarding(o, new Set(['gateway.routing-aliases']))).toEqual(expect.arrayContaining([expect.stringMatching(/unknown concept/)]));
    const dup = { ...o, questions: [...o.questions.slice(0, -1), { ...o.questions.at(-1)!, id: o.questions[0]!.id }] };
    expect(checkOnboarding(dup)).toContain('two onboarding questions have the same id');
    expect(() => parseOnboarding(withQuestions((qs) => qs.map((q, i) => (i === 1 ? { ...q, concept: 'gateway.nope' } : q))))).toThrow(/unknown concept/);
  });

  it('needs an areas list that matches concepts.json exactly', () => {
    const r = real();
    expect(() => parseOnboarding({ ...r, areas: r.areas.slice(1) })).toThrow(/no entry for area "gateway"/);
    expect(() => parseOnboarding({ ...r, areas: [...r.areas, { area: 'made-up', blurb: 'x' }] })).toThrow();
    expect(() => parseOnboarding({ ...r, areas: [...r.areas, { area: 'madeup', blurb: 'x' }] })).toThrow(/not an area/);
    expect(() => parseOnboarding({ ...r, areas: [...r.areas, r.areas[0]] })).toThrow(/same id/);
    expect(() => parseOnboarding({ ...r, areas: undefined })).toThrow(/areas/);
  });

  it('a blurb is one plain line of at most 90 characters', () => {
    const r = real();
    const blurbed = (blurb: string) => ({ ...r, areas: r.areas.map((a: any, i: number) => (i === 0 ? { ...a, blurb } : a)) });
    expect(() => parseOnboarding(blurbed('x'.repeat(90)))).not.toThrow();
    expect(() => parseOnboarding(blurbed('x'.repeat(91)))).toThrow();
    expect(() => parseOnboarding(blurbed('two\nlines'))).toThrow();
    expect(() => parseOnboarding(blurbed('<b>markup</b>'))).toThrow();
    expect(() => parseOnboarding(blurbed(''))).toThrow();
  });
});
