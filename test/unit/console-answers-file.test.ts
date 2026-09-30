import { describe, it, expect } from 'vitest';
import { compileLearnDir } from '../../cli/src/learn-compile';
import { readFileSync } from 'node:fs';

/**
 * What the Questions form writes into workspace/answers.json
 * (dashboard/src/answers-file.js). The lab's checks read that file, so the
 * value types are what matter: number or null, string or null, the chosen
 * choice; and what the form must not disturb: keys it does not know, and keys
 * the learner did not touch.
 */
type Field = { key: string; prompt: string; kind: 'text' | 'number' | 'choice'; choices?: string[] };
const a = (await import('../../dashboard/src/answers-file.js' as string)) as {
  SAFE_FILE: RegExp;
  parseAnswersFile: (t: unknown) => Record<string, unknown>;
  fieldValue: (f: Field, raw: unknown) => unknown;
  displayValue: (f: Field, stored: unknown) => string;
  mergeAnswers: (disk: unknown, fields: Field[], values: Record<string, unknown>, dirty?: Set<string>) => Record<string, unknown>;
  serializeAnswers: (o: unknown) => string;
};

const text: Field = { key: 't', prompt: 'P', kind: 'text' };
const num: Field = { key: 'n', prompt: 'P', kind: 'number' };
const choice: Field = { key: 'c', prompt: 'P', kind: 'choice', choices: ['a', 'b'] };
const fields = [text, num, choice];

describe('the value a field stores', () => {
  it('stores a number as a JSON number, or null when empty', () => {
    expect(a.fieldValue(num, '42')).toBe(42);
    expect(a.fieldValue(num, '-3.5')).toBe(-3.5);
    expect(a.fieldValue(num, '0')).toBe(0);
    expect(a.fieldValue(num, '1e3')).toBe(1000);
    expect(a.fieldValue(num, '')).toBeNull();
    expect(a.fieldValue(num, '   ')).toBeNull();
    expect(a.fieldValue(num, 'abc')).toBeNull();
    expect(a.fieldValue(num, 'Infinity')).toBeNull();
    expect(a.fieldValue(num, null)).toBeNull();
  });

  it('stores text as a string, or null when empty', () => {
    expect(a.fieldValue(text, 'hello gateway')).toBe('hello gateway');
    expect(a.fieldValue(text, ' padded ')).toBe(' padded ');
    expect(a.fieldValue(text, '')).toBeNull();
    expect(a.fieldValue(text, '  ')).toBeNull();
  });

  it('stores a choice as the chosen choice string, or null', () => {
    expect(a.fieldValue(choice, 'a')).toBe('a');
    expect(a.fieldValue(choice, 'b')).toBe('b');
    expect(a.fieldValue(choice, '')).toBeNull();
    expect(a.fieldValue(choice, 'zzz')).toBeNull();
  });

  it('serialises to the JSON the checks can read, with the right types', () => {
    const out = a.mergeAnswers({}, fields, { t: 'x', n: a.fieldValue(num, '7'), c: 'b' }, new Set(['t', 'n', 'c']));
    const parsed = JSON.parse(a.serializeAnswers(out));
    expect(parsed).toEqual({ t: 'x', n: 7, c: 'b' });
    expect(typeof parsed.n).toBe('number');
    expect(a.serializeAnswers(out).endsWith('}\n')).toBe(true);
  });
});

describe('what a control shows for a stored value', () => {
  it('shows numbers, strings and nothing for null', () => {
    expect(a.displayValue(num, 42)).toBe('42');
    expect(a.displayValue(num, null)).toBe('');
    expect(a.displayValue(num, { x: 1 })).toBe('');
    expect(a.displayValue(text, 'hi')).toBe('hi');
    expect(a.displayValue(text, 7)).toBe('7');
    expect(a.displayValue(text, [1])).toBe('');
    expect(a.displayValue(choice, 'a')).toBe('a');
    expect(a.displayValue(choice, 'not-a-choice')).toBe('');
    expect(a.displayValue(choice, undefined)).toBe('');
  });
});

describe('reading the file', () => {
  it('reads an object, and treats anything else as empty', () => {
    expect(a.parseAnswersFile('{"t":"x"}')).toEqual({ t: 'x' });
    for (const bad of ['', '   ', '{', 'null', '[]', '"s"', '7', undefined, null]) expect(a.parseAnswersFile(bad), String(bad)).toEqual({});
  });
});

describe('merging the form into the file', () => {
  const values = { t: 'mine', n: 5, c: 'a' };

  it('fills every field when the file is missing or empty', () => {
    expect(a.mergeAnswers({}, fields, values, new Set())).toEqual({ t: 'mine', n: 5, c: 'a' });
    expect(a.mergeAnswers({}, fields, { t: null, n: null, c: null }, new Set())).toEqual({ t: null, n: null, c: null });
  });

  it('keeps keys the form does not know, in place', () => {
    const out = a.mergeAnswers({ extra: { deep: [1, 2] }, t: 'old' }, fields, values, new Set(['t']));
    expect(out).toEqual({ extra: { deep: [1, 2] }, t: 'mine', n: 5, c: 'a' });
    expect(Object.keys(out)).toEqual(['extra', 't', 'n', 'c']);
  });

  it('a key the learner changed wins over the file', () => {
    expect(a.mergeAnswers({ t: 'edited elsewhere', n: 1 }, fields, values, new Set(['t'])).t).toBe('mine');
  });

  it('a key the learner did not touch keeps what the file holds now (edited in the editor meanwhile)', () => {
    const out = a.mergeAnswers({ t: 'from the editor', n: 99, c: 'b' }, fields, { t: 'stale', n: 5, c: 'a' }, new Set(['n']));
    expect(out).toEqual({ t: 'from the editor', n: 5, c: 'b' });
  });

  it('fills a key the file lacks even if the learner has not touched it', () => {
    expect(a.mergeAnswers({ t: 'x' }, fields, values, new Set())).toEqual({ t: 'x', n: 5, c: 'a' });
  });

  it('does not mutate what it was given', () => {
    const disk = { t: 'x' };
    a.mergeAnswers(disk, fields, values, new Set(['t']));
    expect(disk).toEqual({ t: 'x' });
  });

  it('survives a file that is not an object, and a hostile __proto__ key', () => {
    expect(a.mergeAnswers(null, fields, values)).toEqual(values);
    expect(a.mergeAnswers([1, 2], fields, values)).toEqual(values);
    const disk = JSON.parse('{"__proto__":{"polluted":true},"t":"x"}');
    const out = a.mergeAnswers(disk, fields, values, new Set());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.t).toBe('x');
  });
});

describe('the file name', () => {
  it('allows a plain file name in /workspace and nothing that leaves it', () => {
    for (const ok of ['answers.json', 'my-answers_2.json', 'a']) expect(a.SAFE_FILE.test(ok), ok).toBe(true);
    for (const bad of ['..', '.', '../x', 'a/b', '.hidden', '', '-rf', 'a b']) expect(a.SAFE_FILE.test(bad), bad).toBe(false);
  });

  it('accepts the answers file of every lab that ships one, and reads its template', () => {
    for (const lab of ['see-what-a-gateway-does', 'see-how-tools-reach-an-agent']) {
      const compiled = compileLearnDir(`labs/${lab}`);
      const bundle = compiled?.bundle;
      if (!bundle || bundle.fields.length === 0) continue;
      expect(a.SAFE_FILE.test(bundle.answers_file), lab).toBe(true);
      // The template's keys are the fields' keys, so a fresh form fills it exactly.
      const template = a.parseAnswersFile(readFileSync(`labs/${lab}/workspace/${bundle.answers_file}`, 'utf8'));
      expect(Object.keys(template).sort(), lab).toEqual(bundle.fields.map((f) => f.key).sort());
    }
  });
});
