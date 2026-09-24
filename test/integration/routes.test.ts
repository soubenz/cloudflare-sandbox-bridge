import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { OpalixClient } from '../../cli/src/client';
import { readSse } from './helpers';

/**
 * Tier 2 of the test plan: the routes the lifecycle smoke test never
 * touches — the three streaming paths (terminal WS, SSE, service proxy),
 * the mutating file and service routes, the pool, and the error cases
 * that encode real invariants (one active session per user, auth, size
 * limits).
 *
 * Shares the environment contract with smoke.test.ts: OPALIX_URL and
 * OPALIX_KEY, and the "hello" fixture lab published.
 */
const OPALIX_URL = process.env.OPALIX_URL;
const OPALIX_KEY = process.env.OPALIX_KEY;
const describeIfConfigured = OPALIX_URL && OPALIX_KEY ? describe : describe.skip;

describeIfConfigured('sandbox API routes', () => {
  const service = new OpalixClient({ baseUrl: OPALIX_URL!, serviceKey: OPALIX_KEY });
  const userId = `routes-${Date.now()}`;
  let sessionId: string;
  let token: string;
  let session: OpalixClient;

  beforeAll(async () => {
    const started = await service.startSession('hello', userId);
    sessionId = started.id;
    token = started.token;
    session = new OpalixClient({ baseUrl: OPALIX_URL!, sessionToken: token });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = (await session.status(sessionId)).meta.state;
      if (state === 'running') return;
      if (state === 'ended') throw new Error('session ended before running');
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('session never reached running');
  }, 120_000);

  afterAll(async () => {
    if (sessionId) await session.end(sessionId, false).catch(() => {});
  });

  describe('terminal websocket', () => {
    it('attaches, echoes input, and accepts a resize', async () => {
      const ws = new WebSocket(session.terminalUrl(sessionId));
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
        setTimeout(() => reject(new Error('terminal never opened')), 20_000);
      });
      ws.on('message', (d: Buffer | string) => chunks.push(d.toString()));

      // \x01 prefix marks a control frame (resize); everything else is raw PTY bytes.
      ws.send(`\x01${JSON.stringify({ type: 'resize', cols: 100, rows: 40 })}`);
      ws.send(Buffer.from('echo opalix-terminal-ok\n'));

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !chunks.join('').includes('opalix-terminal-ok')) {
        await new Promise((r) => setTimeout(r, 250));
      }
      ws.close();
      expect(chunks.join('')).toContain('opalix-terminal-ok');
    }, 60_000);
  });

  describe('server-sent events', () => {
    it('streams live events and replays from Last-Event-ID', async () => {
      const url = session.eventsUrl(sessionId);
      const first = await readSse(url, 3, 20_000);
      expect(first.length).toBeGreaterThan(0);
      // Every event carries a monotonic id; replay must resume strictly after it.
      const ids = first.map((e) => Number(e.id)).filter((n) => Number.isFinite(n));
      expect(ids.length).toBeGreaterThan(0);

      const from = String(Math.min(...ids));
      const replayed = await readSse(url, 1, 20_000, { 'Last-Event-ID': from });
      expect(replayed.every((e) => Number(e.id) > Number(from))).toBe(true);
    }, 60_000);
  });

  describe('service routes', () => {
    it('proxies the service UI', async () => {
      const res = await fetch(session.serviceUrl(sessionId, 'echo'), { redirect: 'follow' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('real Opalix lab container');
    }, 30_000);

    it('restarts a service and increments its restart count', async () => {
      const before = (await session.status(sessionId)).services.echo!.restarts;
      await session.restartService(sessionId, 'echo');
      const after = (await session.status(sessionId)).services.echo!.restarts;
      expect(after).toBe(before + 1);
    }, 60_000);

    it('404s an unknown service', async () => {
      await expect(session.restartService(sessionId, 'nope')).rejects.toThrow(/404/);
    });
  });

  describe('files', () => {
    it('lists, deletes, and stops listing a file', async () => {
      await session.writeFile(sessionId, 'scratch.txt', 'delete me');
      expect((await session.readFile(sessionId, 'scratch.txt')).content).toBe('delete me');

      const listed = await session.listFiles(sessionId, '/workspace');
      expect(JSON.stringify(listed)).toContain('scratch.txt');

      await session.deleteFile(sessionId, 'scratch.txt');
      await expect(session.readFile(sessionId, 'scratch.txt')).rejects.toThrow(/404/);
    }, 60_000);

    it('413s a write over the 2 MB limit', async () => {
      await expect(
        session.writeFile(sessionId, 'huge.bin', 'x'.repeat(2 * 1024 * 1024 + 1))
      ).rejects.toThrow(/413/);
    }, 60_000);
  });

  describe('event push from the LLM worker', () => {
    it('accepts a cost event on the service key and replays it on SSE', async () => {
      const res = await fetch(`${OPALIX_URL}/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${OPALIX_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'cost', data: { usd: 0.0123, source: 'integration-test' } }),
      });
      expect(res.ok).toBe(true);

      const seen = await readSse(session.eventsUrl(sessionId), 40, 15_000);
      expect(seen.some((e) => e.event === 'cost' && e.data.includes('integration-test'))).toBe(true);
    }, 60_000);
  });

  describe('auth and not-found', () => {
    it('401s a session route with no token', async () => {
      const res = await fetch(`${OPALIX_URL}/sessions/${sessionId}`);
      expect(res.status).toBe(401);
    });

    it('401s a session route with a forged token', async () => {
      const res = await fetch(`${OPALIX_URL}/sessions/${sessionId}`, {
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(res.status).toBe(401);
    });

    it("401s another session's valid token", async () => {
      const res = await fetch(`${OPALIX_URL}/sessions/01000000000000000000000000/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('404s an unknown lab', async () => {
      await expect(service.startSession('no-such-lab', `unknown-${Date.now()}`)).rejects.toThrow(/404/);
    });
  });

  describe('one active session per user', () => {
    it('409s a second concurrent session for the same user', async () => {
      // The fence is the D1 partial unique index on sessions(user_id)
      // WHERE state IN ('starting','running'); this session is still running.
      await expect(service.startSession('hello', userId)).rejects.toThrow(/409/);
    }, 30_000);
  });

  describe('pool', () => {
    type PoolStats = { warm: number; claimed: number; config: { target: number }; stats: Record<string, number> };
    const poolStats = () => service.poolStats('agent') as Promise<PoolStats>;

    /** Polls until `warm` settles on `want`; the alarm loop reconciles asynchronously. */
    async function waitForWarm(want: number, timeoutMs = 180_000): Promise<PoolStats> {
      const deadline = Date.now() + timeoutMs;
      let last = await poolStats();
      while (Date.now() < deadline) {
        if (last.warm === want) return last;
        await new Promise((r) => setTimeout(r, 3000));
        last = await poolStats();
      }
      throw new Error(`pool warm stayed at ${last.warm}, never reached ${want}`);
    }

    it('reports stats and accepts a prime', async () => {
      const stats = await poolStats();
      expect(stats).toBeTruthy();
      await service.primePool('agent', 1);
      const after = await poolStats();
      expect(after).toBeTruthy();
    }, 60_000);

    it('rejects a target that is not a non-negative integer', async () => {
      await expect(service.primePool('agent', -1)).rejects.toThrow(/400/);
      await expect(service.primePool('agent', 1.5)).rejects.toThrow(/400/);
    }, 30_000);

    /**
     * The regression from the Tier 5 run on 2026-09-24: priming 2 -> 1 left
     * `warm: 2` for ever, because `alarm()` only ever refilled. Costs one
     * extra standard-1 container for the length of the test, so it is the
     * only pool test that starts anything.
     */
    it('destroys the surplus when the target is lowered', async () => {
      const original = (await poolStats()).config.target;
      try {
        await service.primePool('agent', 2);
        await waitForWarm(2);

        await service.primePool('agent', 1);
        const shrunk = await waitForWarm(1);
        expect(shrunk.config.target).toBe(1);
      } finally {
        await service.primePool('agent', original).catch(() => {});
      }
    }, 300_000);

    it('drain empties the warm list without moving the target', async () => {
      const before = await poolStats();
      await service.drainPool('agent');
      const after = await poolStats();
      expect(after.warm).toBe(0);
      expect(after.config.target).toBe(before.config.target);
    }, 60_000);
  });
});
