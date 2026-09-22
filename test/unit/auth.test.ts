import { describe, it, expect } from 'vitest';
import { mintSessionToken, verifySessionToken } from '../../src/auth';
import type { Env } from '../../src/env';

const fakeEnv = { SESSION_TOKEN_SECRET: 'unit-test-secret' } as Env;

describe('session tokens', () => {
  it('round-trips a valid token', async () => {
    const token = await mintSessionToken(fakeEnv, { sid: 'sess-1', uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const payload = await verifySessionToken(fakeEnv, token);
    expect(payload.sid).toBe('sess-1');
    expect(payload.uid).toBe('user-1');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintSessionToken(fakeEnv, { sid: 'sess-1', uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const otherEnv = { SESSION_TOKEN_SECRET: 'different-secret' } as Env;
    await expect(verifySessionToken(otherEnv, token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await mintSessionToken(fakeEnv, { sid: 'sess-1', uid: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifySessionToken(fakeEnv, token)).rejects.toThrow(/expired/);
  });

  it('rejects a malformed token', async () => {
    await expect(verifySessionToken(fakeEnv, 'not-a-real-token')).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const token = await mintSessionToken(fakeEnv, { sid: 'sess-1', uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const [body, sig] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({ sid: 'sess-EVIL', uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    void body;
    await expect(verifySessionToken(fakeEnv, `${tamperedBody}.${sig}`)).rejects.toThrow();
  });
});
