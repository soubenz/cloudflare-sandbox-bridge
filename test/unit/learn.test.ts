import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearnBundleSchema, checkLearnBundle, parseLearnBundle, parseOnboarding, KNOWN_CONCEPTS, type LearnBundle } from '../../src/labs/learn';
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

describe('the onboarding quiz, once written', () => {
  const file = join(__dirname, '..', '..', 'packages', 'catalogue', 'onboarding.json');
  it('validates when present', () => {
    if (!existsSync(file)) return;
    expect(() => parseOnboarding(JSON.parse(readFileSync(file, 'utf8')))).not.toThrow();
  });
});
