import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../../site/src/worker';

function signup(): Request {
  const body = new URLSearchParams({ email: 'ada@example.com', plan: 'team' });
  return new Request('https://opalix-site.example.workers.dev/api/waitlist', { method: 'POST', body });
}

function env(extra: Partial<Env> = {}): { env: Env; writes: unknown[][] } {
  const writes: unknown[][] = [];
  const DB = {
    prepare: () => ({ bind: (...params: unknown[]) => ({ run: async () => { writes.push(params); } }) }),
  } as unknown as D1Database;
  const ASSETS = { fetch: async () => new Response('asset') } as unknown as Fetcher;
  return { env: { ASSETS, DB, ...extra }, writes };
}

describe('site worker waitlist endpoint', () => {
  it('stores a valid signup and redirects to the thanks page', async () => {
    const { env: e, writes } = env();
    const res = await worker.fetch(signup(), e);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://opalix-site.example.workers.dev/waitlist/thanks');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('ada@example.com');
  });

  it('on a PR preview, answers the same way but never writes to the database', async () => {
    const { env: e, writes } = env({ PREVIEW: 'true' });
    const res = await worker.fetch(signup(), e);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://opalix-site.example.workers.dev/waitlist/thanks');
    expect(writes).toHaveLength(0);
  });

  it('on a PR preview, still rejects a bad email', async () => {
    const { env: e } = env({ PREVIEW: 'true' });
    const body = new URLSearchParams({ email: 'nope', plan: 'team' });
    const res = await worker.fetch(new Request('https://x.workers.dev/api/waitlist', { method: 'POST', body }), e);
    expect(res.headers.get('Location')).toBe('https://x.workers.dev/waitlist?e=email&plan=team');
  });
});
