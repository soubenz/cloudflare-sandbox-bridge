import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLearnUpload } from '../../cli/src/commands/labs';
import { parseLearnBundle } from '../../src/labs/learn';

/** What `labs publish` does with learn/: compile it, refuse on problems, send the JSON the Worker will re-validate. */

function labDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'opalix-learn-publish-'));
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
};

function withDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = labDir(files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildLearnUpload', () => {
  it('is undefined for a lab without a learn/ folder', () => {
    expect(withDir({ 'manifest.yaml': 'slug: x\n' }, buildLearnUpload)).toBeUndefined();
  });

  it('returns the compiled bundle as JSON that the Worker accepts, with counts for the log line', () => {
    const up = withDir(GOOD, buildLearnUpload)!;
    expect(up).toMatchObject({ lessons: 1, questions: 1, fields: 0 });
    const bundle = parseLearnBundle(JSON.parse(up.json));
    expect(bundle.story!.title).toBe('Monday at Larkfield');
    expect(bundle.concepts[0]!.id).toBe('gateway.routing-aliases');
  });

  it('refuses a lab whose learn/ has problems and lists every one', () => {
    const files = {
      ...GOOD,
      // problem 1: a lesson for a concept the registry does not know; problem 2: the question's concept has no lesson.
      'learn/concepts/gateway.routing-aliases.md': GOOD['learn/concepts/gateway.routing-aliases.md']!.replace('id: gateway.routing-aliases', 'id: made.up-concept'),
      'learn/quiz.yaml': GOOD['learn/quiz.yaml']!.replace('answer: [a]', 'answer: [zzz]'),
    };
    const err = withDir(files, (dir) => {
      try {
        buildLearnUpload(dir);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/refusing to publish/);
    expect(err!.message).toMatch(/learn\/ has \d+ problems/);
    expect(err!.message).toMatch(/must equal the file name/);
    expect(err!.message).toMatch(/answer "zzz" is not one of its options/);
    expect(err!.message).toMatch(/learn-check/);
    // One bullet per problem.
    expect(err!.message.split('\n').filter((l) => l.startsWith('  - ')).length).toBeGreaterThanOrEqual(2);
  });
});
