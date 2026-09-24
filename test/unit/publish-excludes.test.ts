import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TAR_EXCLUDES } from '../../cli/src/commands/labs';

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
