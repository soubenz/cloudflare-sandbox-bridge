import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSolutionFiles, encodeWorkspacePath, formatCheckSummary, judgeLabTest, registerLabsCommands } from '../../cli/src/commands/labs';
import type { OpalixClient } from '../../cli/src/client';

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

  it('skips the author-only _degenerate directory at the top level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-solution-'));
    try {
      writeFileSync(join(dir, 'app.py'), 'ok');
      mkdirSync(join(dir, '_degenerate'), { recursive: true });
      writeFileSync(join(dir, '_degenerate', 'app.py'), 'cheat');
      mkdirSync(join(dir, 'src', '_degenerate'), { recursive: true });
      writeFileSync(join(dir, 'src', '_degenerate', 'note.txt'), 'nested dirs of that name are ordinary');
      expect(collectSolutionFiles(dir)).toEqual(['app.py', 'src/_degenerate/note.txt']);
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

/**
 * A warm-up has no container. `labs publish` sends the manifest and the
 * learn bundle and nothing else; `labs test` compiles learn/ and never
 * starts a session.
 */
const WARM_UP_MANIFEST = `slug: first-steps
version: 1.0.0
title: "First steps"
type: warm-up
tier: free
difficulty: intro
estimated_minutes: 10
`;
const CLOSING_MD = '---\ntitle: Friday at Larkfield\nminutes: 2\n---\nBy Friday we knew.\n';
const CLOSING_YAML = `title: What we found
panels:
  - scene: desk
    cast: [maren]
    voiceover: By Friday we knew which provider had answered.
    bubbles:
      - { who: maren, text: "So that was it." }
  - scene: portrait
    cast: [tomasz]
    voiceover: The alias had moved and nobody had noticed.
  - scene: screen
    voiceover: Here is the line that told us.
    lines: ["alias: fast = provider-b"]
  - scene: you
    voiceover: Now try it yourself.
    lines: ["curl the gateway"]
`;
const GAMES_YAML = `games:
  - kind: flag
    id: flag-logs
    title: Spot the leak
    prompt: Flag the log lines that leak a secret.
    explanation: Keys never belong in logs.
    items:
      - { id: a, text: "key=sk-123", flag: true, why: A raw key. }
      - { id: b, text: "status=200", flag: false }
      - { id: c, text: "model=fast", flag: false }
`;
const GOOD_WARM_UP: Record<string, string> = {
  'manifest.yaml': WARM_UP_MANIFEST,
  'learn/closing.md': CLOSING_MD,
  'learn/closing.yaml': CLOSING_YAML,
  'learn/games.yaml': GAMES_YAML,
};

function warmUpDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'opalix-warmup-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function runLabs(args: string[], client: Partial<OpalixClient>): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerLabsCommands(program, () => client as OpalixClient);
  await program.parseAsync(['node', 'opalix', 'labs', ...args]);
}

describe('warm-ups in the labs commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('publish sends the manifest and learn parts only, with no workspace, private or solution part', async () => {
    // Directories a warm-up must not ship are present on disk and ignored; lint is skipped so only publish itself is under test.
    const dir = warmUpDir({ ...GOOD_WARM_UP, 'workspace/notes.txt': 'x', 'solution/answer.txt': 'y', 'brief.md': 'hi' });
    let sent: FormData | undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runLabs(['publish', dir, '--skip-lint'], {
        publishLab: async (form: FormData) => {
          sent = form;
          return { slug: 'first-steps', version: '1.0.0' };
        },
      });
      expect(sent).toBeDefined();
      expect([...sent!.keys()].sort()).toEqual(['learn', 'manifest']);
      const manifest = JSON.parse(await (sent!.get('manifest') as File).text());
      expect(manifest).toMatchObject({ slug: 'first-steps', type: 'warm-up' });
      const learn = JSON.parse(await (sent!.get('learn') as File).text());
      expect(learn.games.map((g: { id: string }) => g.id)).toEqual(['flag-logs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish refuses a warm-up with no learn/ folder, before any upload', async () => {
    const dir = warmUpDir({ 'manifest.yaml': WARM_UP_MANIFEST });
    const publishLab = vi.fn();
    try {
      await expect(runLabs(['publish', dir], { publishLab })).rejects.toThrow(/a warm-up needs a learn\/ folder/);
      expect(publishLab).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish refuses a warm-up whose learn/ has no games and no story', async () => {
    const dir = warmUpDir({ 'manifest.yaml': WARM_UP_MANIFEST, 'learn/quiz.yaml': 'questions: []\n' });
    const publishLab = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runLabs(['publish', dir, '--skip-lint'], { publishLab })).rejects.toThrow(/refusing to publish/);
      expect(publishLab).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test exits 0 on a clean warm-up and never starts a session', async () => {
    const dir = warmUpDir(GOOD_WARM_UP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // getClient() would throw: any attempt to reach the API fails the test.
      const program = new Command();
      program.exitOverride();
      registerLabsCommands(program, () => {
        throw new Error('labs test must not create a client for a warm-up');
      });
      await program.parseAsync(['node', 'opalix', 'labs', 'test', dir]);
      expect(process.exitCode).toBeUndefined();
      expect(log.mock.calls.map((c) => c.join(' '))).toContain('warm-up: no container to test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test exits non-zero and lists the problems when a warm-up learn/ does not compile', async () => {
    const dir = warmUpDir({ ...GOOD_WARM_UP, 'learn/games.yaml': 'nothing: here\n' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runLabs(['test', dir], {});
      expect(process.exitCode).toBe(1);
      expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/games\.yaml: expected a top-level `games:` list/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
