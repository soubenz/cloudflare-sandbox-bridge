import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSolutionFiles, encodeWorkspacePath, formatCheckSummary, judgeLabTest } from '../../cli/src/commands/labs';

/**
 * The pure half of `opalix labs test`: which solution files get uploaded,
 * where, how the two check runs are printed, and — the part that decides the
 * exit code — whether the lab is sound (fails fresh, passes with solution/).
 */

const pass = (name: string, message = 'ok') => ({ name, pass: true, message });
const fail = (name: string, message = 'nope') => ({ name, pass: false, message });

describe('collectSolutionFiles', () => {
  it('walks nested directories and returns sorted relative POSIX paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-solution-'));
    try {
      writeFileSync(join(dir, 'greeting.txt'), 'hi');
      mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.py'), 'print()');
      writeFileSync(join(dir, 'src', 'deep', 'config.yml'), 'a: 1');
      expect(collectSolutionFiles(dir)).toEqual(['greeting.txt', 'src/app.py', 'src/deep/config.yml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for an empty solution directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-solution-'));
    try {
      expect(collectSolutionFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('encodeWorkspacePath', () => {
  it('keeps separators and encodes each segment', () => {
    expect(encodeWorkspacePath('src/app.py')).toBe('src/app.py');
    expect(encodeWorkspacePath('a dir/my file.txt')).toBe('a%20dir/my%20file.txt');
    expect(encodeWorkspacePath('weird/na#me?.txt')).toBe('weird/na%23me%3F.txt');
  });
});

describe('formatCheckSummary', () => {
  it('prints one line per check plus a tally', () => {
    expect(formatCheckSummary([pass('a', 'all good'), fail('b', 'broken')])).toEqual([
      '  PASS  a — all good',
      '  FAIL  b — broken',
      '  1/2 checks passed.',
    ]);
  });

  it('flattens multi-line messages so one check stays one line', () => {
    expect(formatCheckSummary([fail('b', 'first\n\n  second  ')])[0]).toBe('  FAIL  b — first / second');
  });

  it('says so when nothing ran', () => {
    expect(formatCheckSummary([])).toEqual(['  (no checks ran)']);
  });
});

describe('judgeLabTest', () => {
  it('passes a lab that fails fresh and passes after the solution', () => {
    expect(judgeLabTest({ fresh: [fail('a'), pass('b')], afterSolution: [pass('a'), pass('b')], hasSolution: true })).toEqual([]);
  });

  it('rejects a lab whose checks already pass on a fresh session', () => {
    const problems = judgeLabTest({ fresh: [pass('a')], afterSolution: [pass('a')], hasSolution: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no task in it/);
  });

  it('rejects a lab whose checks still fail with the solution applied', () => {
    const problems = judgeLabTest({ fresh: [fail('a')], afterSolution: [fail('a', 'still broken')], hasSolution: true });
    expect(problems).toEqual(['check "a" still fails after applying solution/: still broken']);
  });

  it('reports both halves when both are wrong', () => {
    const problems = judgeLabTest({ fresh: [pass('a')], afterSolution: [fail('a')], hasSolution: true });
    expect(problems).toHaveLength(2);
  });

  it('refuses to call a lab verified when there is no solution to apply', () => {
    const problems = judgeLabTest({ fresh: [fail('a')], hasSolution: false });
    expect(problems).toEqual(['no solution/ directory to apply — the pass case was NOT verified']);
  });

  it('flags a lab that declares no checks at all', () => {
    const problems = judgeLabTest({ fresh: [], afterSolution: [], hasSolution: true });
    expect(problems[0]).toMatch(/no checks ran on the fresh session/);
  });

  it('flags a post-solution run that never completed', () => {
    const problems = judgeLabTest({ fresh: [fail('a')], hasSolution: true });
    expect(problems).toEqual(['the post-solution check run did not complete']);
  });
});
