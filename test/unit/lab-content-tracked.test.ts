import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Everything under `labs/` is source, and nothing in it may be git-ignored.
 *
 * This exists because `.gitignore`'s `*.log` silently kept the six pasted log
 * files out of `labs/forgotten-rules/workspace/attachments/`. The case file
 * names those attachments rather than embedding them, and they are what makes
 * the transcript too big to send — so a fresh clone got a lab whose planted
 * bug had nothing left to trigger it. `labs publish` packs from the working
 * tree, so an author on the machine that wrote the files could publish a
 * working lab and push a broken one, and every existing test stayed green.
 *
 * The general rule is the fence, not a second `!labs/**` negation per pattern:
 * `dist/`, `*.pyc`, `.DS_Store` and anything added later are all ways to lose
 * lab content the same way, and only `__pycache__`/`*.pyc` are content we
 * actually want dropped (see the two allowances below).
 */
describe('lab content is tracked', () => {
  it('has no git-ignored files under labs/', () => {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', 'labs/'],
      { encoding: 'utf8' },
    ).trim();

    // Python bytecode is the one thing we do want ignored under labs/: a stale
    // .pyc shadows the .py source a break-fix lab asks the learner to edit.
    const offenders = out
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes('__pycache__/') && !line.endsWith('.pyc'));

    expect(offenders, `git-ignored lab content:\n${offenders.join('\n')}`).toEqual([]);
  });
});
