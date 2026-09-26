import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpalixClient } from '../../cli/src/client';
import { execViaTerminal, startRunningSession } from './helpers';

/**
 * Tier 4 of the test plan: the egress fence. `static enableInternet =
 * false` plus `allowedHosts` is what stops learner code — and anything a
 * learner's agent is talked into running — from reaching the internet. It
 * is the one security control in this layer, and it had never been
 * exercised.
 *
 * Probes run inside the container over the terminal websocket, because
 * that is the only route that executes arbitrary commands and it is also
 * exactly the surface a learner has.
 */
const OPALIX_URL = process.env.OPALIX_URL;
const OPALIX_KEY = process.env.OPALIX_KEY;
const describeIfConfigured = OPALIX_URL && OPALIX_KEY ? describe : describe.skip;

describeIfConfigured('egress fence', () => {
  const service = new OpalixClient({ baseUrl: OPALIX_URL!, serviceKey: OPALIX_KEY });
  let sessionId: string;
  let session: OpalixClient;
  let terminalUrl: string;

  beforeAll(async () => {
    const started = await startRunningSession(service, OPALIX_URL!, 'hello');
    sessionId = started.id;
    session = started.session;
    terminalUrl = session.terminalUrl(sessionId);
  }, 180_000);

  afterAll(async () => {
    if (sessionId) await session.end(sessionId, false).catch(() => {});
  });

  it('reaches an allowed host through its outbound handler', async () => {
    // bundles.opalix.internal is served by bundlesOutbound straight from
    // R2, so a success here proves both halves at once: the allowlist let
    // the request out, and the Worker-side handler intercepted it.
    const { output } = await execViaTerminal(
      terminalUrl,
      'curl -s -m 20 -o /tmp/probe.tgz -w "HTTPCODE=%{http_code}" http://bundles.opalix.internal/labs/hello/1.0.0/workspace.tgz; echo; file -b /tmp/probe.tgz'
    );
    expect(output).toContain('HTTPCODE=200');
    expect(output.toLowerCase()).toContain('gzip');
  }, 120_000);

  // A host outside allowedHosts is rejected by ContainerProxy with 520;
  // if the fence is off entirely the origin answers normally instead.
  // Asserting the exact code matters: an earlier version of this test
  // looked for the substring "200" anywhere in the stream and could not
  // distinguish a real response from the shell's echo of the command.
  it.each([
    ['an arbitrary host', '-s', 'http://example.com/'],
    ['a raw IP, bypassing DNS', '-s', 'http://1.1.1.1/'],
    ['https to a denied host', '-sk', 'https://example.com/'],
  ])('refuses %s', async (_label, flags, url) => {
    const { output } = await execViaTerminal(
      terminalUrl,
      `curl ${flags} -m 15 -o /dev/null -w "HTTPCODE=%{http_code}" ${url}`
    );
    expect(output).not.toContain('HTTPCODE=200');
    expect(output).toMatch(/HTTPCODE=(520|000)/);
  }, 120_000);

  it('never exposes platform credentials to the container', async () => {
    // The whole point of injecting the LLM credential in an outbound
    // handler is that the container cannot read it. Nor should it hold
    // the service key or the token-signing secret: with those, a learner
    // could mint tokens for other sessions.
    const { output } = await execViaTerminal(
      terminalUrl,
      "env; echo ---; cat /etc/opalix/session.env 2>/dev/null; echo ---; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'"
    );
    for (const secret of ['LLM_WORKER_KEY', 'SANDBOX_API_KEY', 'SESSION_TOKEN_SECRET', 'R2_SECRET_ACCESS_KEY']) {
      expect(output).not.toContain(secret);
    }
  }, 120_000);

  it('gives the learner the lab env but runs them unprivileged', async () => {
    const { output } = await execViaTerminal(terminalUrl, 'id -un; echo "GREETING=[$GREETING]"');
    expect(output).toContain('GREETING=[hello from opalix]');
    expect(output).not.toMatch(/^root$/m);
  }, 120_000);

  it('lets Python httpx reach an allowed HTTPS host (not just curl/urllib)', async () => {
    // opalix-init.sh adds the outbound CA to the system store, but httpx
    // (and requests) verify against certifi's own bundle instead, not the
    // system store -- so this fails CERTIFICATE_VERIFY_FAILED unless the
    // image also points SSL_CERT_FILE/REQUESTS_CA_BUNDLE at the system
    // bundle (see docs/spike.md's live gateway container spike).
    const { output } = await execViaTerminal(
      terminalUrl,
      `python3 -c "import httpx; print('STATUS', httpx.get('https://gateway.ai.cloudflare.com/v1', timeout=20).status_code)"`
    );
    expect(output).toMatch(/STATUS \d+/);
    expect(output).not.toContain('CERTIFICATE_VERIFY_FAILED');
  }, 120_000);

  it('keeps the grader out of reach of the learner', async () => {
    // /opt/lab holds the private bundle (checks + pressure scripts). A
    // learner who can read it can read the grader and the answers.
    const { output } = await execViaTerminal(terminalUrl, 'ls -la /opt/lab 2>&1 | head -5');
    expect(output).toMatch(/Permission denied|No such file/i);
  }, 120_000);
});
