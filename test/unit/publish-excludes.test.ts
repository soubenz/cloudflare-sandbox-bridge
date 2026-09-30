import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TAR_EXCLUDES, buildSolutionTgz, collectSolutionUploadFiles } from '../../cli/src/commands/labs';
import { gunzip, parseTar } from '../../src/lib/tar';
import { streamOf } from './tar-writer';

/**
 * `workspace/` is extracted verbatim into the learner's container, so
 * anything the author's working tree happens to contain ships to every
 * learner. Nine `.pyc` files were committed and would have been published
 * that way — stale bytecode shadowing the very `.py` sources a break-fix
 * lab asks a learner to edit.
 *
 * This runs the real tar invocation rather than asserting on the flag list,
 * because the flags are only correct if tar agrees with them.
 */
describe('published lab bundles', () => {
  it('excludes build droppings but keeps real sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-excl-'));
    try {
      mkdirSync(join(dir, 'agent/__pycache__'), { recursive: true });
      mkdirSync(join(dir, 'nested/deep/__pycache__'), { recursive: true });
      mkdirSync(join(dir, '.pytest_cache'), { recursive: true });
      writeFileSync(join(dir, 'agent/mailer.py'), 'real source');
      writeFileSync(join(dir, 'agent/__pycache__/mailer.cpython-311.pyc'), 'stale');
      writeFileSync(join(dir, 'nested/deep/__pycache__/x.cpython-311.pyc'), 'stale');
      writeFileSync(join(dir, 'agent/loose.pyc'), 'stale');
      writeFileSync(join(dir, 'agent/loose.pyo'), 'stale');
      writeFileSync(join(dir, '.DS_Store'), 'noise');
      writeFileSync(join(dir, '.pytest_cache/CACHEDIR.TAG'), 'noise');
      writeFileSync(join(dir, 'tickets.json'), '[]');

      const tgz = execFileSync('tar', ['czf', '-', ...TAR_EXCLUDES, '-C', dir, '.']);
      const listed = execFileSync('tar', ['tzf', '-'], { input: tgz }).toString();

      expect(listed).toContain('./agent/mailer.py');
      expect(listed).toContain('./tickets.json');

      expect(listed).not.toMatch(/\.pyc/);
      expect(listed).not.toMatch(/\.pyo/);
      expect(listed).not.toMatch(/__pycache__/);
      expect(listed).not.toContain('.DS_Store');
      expect(listed).not.toContain('.pytest_cache');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * solution/ is now uploaded (privately) and shown to learners under the
 * unlock rule, so what is packed matters: the author's `_degenerate/` wrong
 * answers and build droppings must stay out, and the archive must read back
 * in the Worker with its paths relative to /workspace.
 */
describe('published solution bundle', () => {
  function withSolution(fn: (dir: string) => void | Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'opalix-sol-'));
      try {
        mkdirSync(join(dir, 'app/__pycache__'), { recursive: true });
        mkdirSync(join(dir, 'app/sub'), { recursive: true });
        mkdirSync(join(dir, '_degenerate/wrong-answer'), { recursive: true });
        mkdirSync(join(dir, 'app/_degenerate'), { recursive: true });
        mkdirSync(join(dir, '.hidden'), { recursive: true });
        writeFileSync(join(dir, 'app/main.py'), 'print("solved")\n');
        writeFileSync(join(dir, 'app/sub/util.py'), 'x = 1\n');
        writeFileSync(join(dir, 'config.yaml'), 'ok: true\n');
        writeFileSync(join(dir, '-dashed.txt'), 'starts with a dash');
        writeFileSync(join(dir, '_degenerate/main.py'), 'print("WRONG")\n');
        writeFileSync(join(dir, '_degenerate/wrong-answer/x.py'), 'wrong');
        writeFileSync(join(dir, 'app/_degenerate/keep-me.py'), 'a nested _degenerate is an ordinary directory');
        writeFileSync(join(dir, 'app/__pycache__/main.cpython-311.pyc'), 'stale');
        writeFileSync(join(dir, 'app/loose.pyc'), 'stale');
        writeFileSync(join(dir, 'app/loose.pyo'), 'stale');
        writeFileSync(join(dir, '.DS_Store'), 'noise');
        writeFileSync(join(dir, 'app/.DS_Store'), 'noise');
        writeFileSync(join(dir, '.hidden/secret.txt'), 'noise');
        writeFileSync(join(dir, '.env'), 'dotfile');
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it('lists sources only: no _degenerate at the top level, no caches, no dotfiles', withSolution((dir) => {
    expect(collectSolutionUploadFiles(dir)).toEqual([
      '-dashed.txt',
      'app/_degenerate/keep-me.py',
      'app/main.py',
      'app/sub/util.py',
      'config.yaml',
    ]);
  }));

  it('packs a tarball whose entries are relative to /workspace and exclude everything above', withSolution((dir) => {
    const packed = buildSolutionTgz(dir)!;
    expect(packed.files).toEqual(collectSolutionUploadFiles(dir));
    const listed = execFileSync('tar', ['tzf', '-'], { input: packed.tgz }).toString();
    expect(listed).toContain('./app/main.py');
    expect(listed).toContain('./config.yaml');
    expect(listed).not.toContain('WRONG');
    expect(listed).not.toMatch(/(^|\/)_degenerate\/main\.py/m);
    expect(listed).not.toContain('wrong-answer');
    expect(listed).not.toMatch(/\.pyc|\.pyo|__pycache__|\.DS_Store|\.hidden|\.env/);
    expect(listed).not.toContain('workspace/');
  }));

  it('is read back by the Worker parser to exactly those files, with their contents', withSolution(async (dir) => {
    const { tgz } = buildSolutionTgz(dir)!;
    const { bytes } = await gunzip(streamOf(tgz), 1 << 20);
    const { files } = parseTar(bytes);
    const seen = Object.fromEntries(files.map((f) => [f.path, new TextDecoder().decode(f.content)]));
    expect(seen).toEqual({
      '-dashed.txt': 'starts with a dash',
      'app/_degenerate/keep-me.py': 'a nested _degenerate is an ordinary directory',
      'app/main.py': 'print("solved")\n',
      'app/sub/util.py': 'x = 1\n',
      'config.yaml': 'ok: true\n',
    });
  }));

  it('does not follow a symlink out of solution/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-sol-'));
    const outside = mkdtempSync(join(tmpdir(), 'opalix-outside-'));
    try {
      writeFileSync(join(outside, 'private.txt'), 'not part of the solution');
      writeFileSync(join(dir, 'real.txt'), 'real');
      symlinkSync(join(outside, 'private.txt'), join(dir, 'link.txt'));
      symlinkSync(outside, join(dir, 'linked-dir'));
      expect(collectSolutionUploadFiles(dir)).toEqual(['real.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uploads nothing when there is no solution directory, or only _degenerate/ in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opalix-sol-'));
    try {
      expect(buildSolutionTgz(join(dir, 'solution'))).toBeUndefined();
      mkdirSync(join(dir, 'solution/_degenerate'), { recursive: true });
      writeFileSync(join(dir, 'solution/_degenerate/x.py'), 'wrong');
      expect(buildSolutionTgz(join(dir, 'solution'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
