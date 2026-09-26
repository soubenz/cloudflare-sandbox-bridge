import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Each image builds from its own directory, so each one carries its own copy
 * of opalix-init.sh (Docker can't COPY from outside the build context).
 * images/common/ holds the copy to edit. The copies have to stay identical.
 *
 * This test exists because they drifted once: a fix to the learner shell's
 * TLS setup went into images/common/opalix-init.sh only, both images were
 * rebuilt and deployed from their own stale copies, and the fix never
 * reached a container. The live egress suite caught it after the deploy;
 * this catches it before one.
 */
describe('opalix-init.sh copies', () => {
  const common = readFileSync('images/common/opalix-init.sh', 'utf8');

  it.each(['agent', 'gateway'])('images/%s/opalix-init.sh matches images/common', (family) => {
    const copy = readFileSync(`images/${family}/opalix-init.sh`, 'utf8');
    expect(copy, `images/${family}/opalix-init.sh differs from images/common/opalix-init.sh -- copy the common one over it`).toBe(common);
  });
});
