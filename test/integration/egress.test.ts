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
      'curl -s -o /tmp/probe.tgz -w "%{http_code}" http://bundles.opalix.internal/labs/hello/1.0.0/workspace.tgz && file -b /tmp/probe.tgz'
    );
    expect(output).toContain('200');
    expect(output.toLowerCase()).toContain('gzip');
  }, 120_000);

  it('refuses an arbitrary host', async () => {
    const { output, exitCode } = await execViaTerminal(
      terminalUrl,
      'curl -s -m 10 -o /dev/null -w "%{http_code}" http://example.com/'
    );
    // Either curl fails outright or it gets a non-2xx; what must not
    // happen is a 200 from the real example.com.
    expect(output).not.toContain('200');
    if (exitCode === 0) expect(output.trim()).not.toMatch(/^2\d\d$/);
  }, 120_000);

  it('refuses a raw IP, bypassing DNS', async () => {
    const { output } = await execViaTerminal(
      terminalUrl,
      'curl -s -m 10 -o /dev/null -w "%{http_code}" http://1.1.1.1/'
    );
    expect(output).not.toContain('200');
  }, 120_000);

  it('refuses https to a denied host', async () => {
    const { output } = await execViaTerminal(
      terminalUrl,
      'curl -sk -m 10 -o /dev/null -w "%{http_code}" https://example.com/'
    );
    expect(output).not.toContain('200');
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

  it('keeps the grader out of reach of the learner', async () => {
    // /opt/lab holds the private bundle (checks + pressure scripts). A
    // learner who can read it can read the grader and the answers.
    const { output } = await execViaTerminal(terminalUrl, 'ls -la /opt/lab 2>&1 | head -5');
    expect(output).toMatch(/Permission denied|No such file/i);
  }, 120_000);
});
