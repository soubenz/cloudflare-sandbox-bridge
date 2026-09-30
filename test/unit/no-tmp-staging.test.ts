import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Card B-08: archives the Worker later extracts must never be staged in the
 * world-writable temp dir, where the learner could swap them between the
 * writeFile and the extract exec (TOCTOU). They go to a root-only 0700
 * directory created by opalix-init.sh instead.
 */
describe('no world-writable staging', () => {
  const FORBIDDEN = ['/tmp', '/'].join('');
  it.each(['src/session/checks.ts', 'src/session/hydrate.ts'])('%s does not reference the temp dir', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain(FORBIDDEN);
  });

  it.each(['common', 'agent', 'gateway'])('images/%s/opalix-init.sh creates the root-only stage dir', (family) => {
    expect(readFileSync(`images/${family}/opalix-init.sh`, 'utf8')).toContain('/run/opalix/stage');
  });

  it('staged archives live under /run/opalix/stage', () => {
    expect(readFileSync('src/session/hydrate.ts', 'utf8')).toContain("STAGE_DIR = '/run/opalix/stage'");
  });
});
