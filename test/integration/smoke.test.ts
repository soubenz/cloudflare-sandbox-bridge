import { describe, it, expect, beforeAll } from 'vitest';
import { OpalixClient } from '../../cli/src/client';
import type { SessionCreateResponse } from '../../cli/src/client';

/**
 * Exercises the full session lifecycle against a live Worker — `wrangler
 * dev` (needs Docker for the container bindings) or a staging deployment.
 * Not run in CI by default (see package.json's `test` vs `test:integration`
 * scripts); this is the automated form of the manual walkthrough in
 * docs/spike.md.
 *
 * Requires: OPALIX_URL, OPALIX_KEY env vars (the same pair the CLI reads),
 * and the "hello" fixture lab already published
 * (`npm run opalix -- labs publish test/fixtures/labs/hello`).
 *
 * Not BASE_URL: Vite defines `import.meta.env.BASE_URL` from its `base`
 * option, and vitest backs `import.meta.env` with `process.env`, so a
 * BASE_URL exported by the shell is overwritten with "/" inside a test.
 */
const OPALIX_URL = process.env.OPALIX_URL;
const OPALIX_KEY = process.env.OPALIX_KEY;
// createBackup needs R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY worker secrets for
// presigned uploads. Without them snapshot/resume cannot run at all, so opt in
// rather than reporting an infrastructure gap as a product failure.
const R2_BACKUPS = process.env.OPALIX_R2_BACKUPS === '1';
const describeIfConfigured = OPALIX_URL && OPALIX_KEY ? describe : describe.skip;

describeIfConfigured('sandbox API smoke test', () => {
  const service = new OpalixClient({ baseUrl: OPALIX_URL!, serviceKey: OPALIX_KEY });
  let sessionId: string;
  let session: OpalixClient;
  let token: string;
  let urls: SessionCreateResponse['urls'];

  beforeAll(async () => {
    const health = await service.health();
    expect(health.ok).toBe(true);
  });

  it('starts a session and reaches running', async () => {
    const started = await service.startSession('hello', `it-${Date.now()}`);
    expect(started.state).toBe('starting');
    sessionId = started.id;
    token = started.token;
    urls = started.urls;
    session = new OpalixClient({ baseUrl: OPALIX_URL!, sessionToken: started.token });

    const deadline = Date.now() + 60_000;
    let state = started.state;
    while (Date.now() < deadline && state !== 'running') {
      await new Promise((r) => setTimeout(r, 1000));
      state = (await session.status(sessionId)).meta.state;
    }
    expect(state).toBe('running');
  }, 90_000);

  it('hands back URLs that actually resolve', async () => {
    // Every other test builds its own URLs from OPALIX_URL, so nothing
    // exercised `urls` from the create response. PUBLIC_BASE_URL pointed
    // at a host with no DNS for the life of this deployment and no test
    // noticed.
    const res = await fetch(`${urls.status}?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(urls.terminal).toMatch(/^wss:\/\//);
    expect(urls.events).toMatch(/^https:\/\//);
  }, 30_000);

  it('writes a file and reads it back', async () => {
    await session.writeFile(sessionId, 'greeting.txt', 'hello from opalix');
    const result = await session.readFile(sessionId, 'greeting.txt');
    expect(result.content).toBe('hello from opalix');
  });

  it('runs checks and reports a pass', async () => {
    const results = await session.runChecks(sessionId);
    expect(results?.results.some((r) => r.name === 'greeting-file-exists' && r.pass)).toBe(true);
  }, 30_000);

  it.skipIf(!R2_BACKUPS)('snapshots, ends, and resumes', async () => {
    await session.snapshot(sessionId);
    await session.end(sessionId, false);
    const resumed = await session.resume(sessionId);
    expect(resumed.meta.state === 'resuming' || resumed.meta.state === 'running').toBe(true);
  }, 60_000);

  it('ends the session for good', async () => {
    await session.end(sessionId, false);
  });
});
