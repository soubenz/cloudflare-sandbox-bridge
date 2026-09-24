import { describe, it, expect, afterEach, vi } from 'vitest';
import { mintSessionToken, verifySessionToken, sessionTokenExp, SESSION_TOKEN_GRACE_MS } from '../../src/auth';
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

describe('sessionTokenExp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('outlives the session it belongs to by the grace window', () => {
    const expiresAt = Date.now() + 120 * 60_000;
    expect(sessionTokenExp(expiresAt)).toBe(Math.floor((expiresAt + SESSION_TOKEN_GRACE_MS) / 1000));
    expect(sessionTokenExp(expiresAt) * 1000).toBeGreaterThan(expiresAt);
  });

  it('keeps a 120-minute lab\'s token valid at the 119-minute mark', async () => {
    const mintedAt = Date.now();
    const token = await mintSessionToken(fakeEnv, {
      sid: 'sess-long',
      uid: 'user-1',
      exp: sessionTokenExp(mintedAt + 120 * 60_000),
    });

    vi.useFakeTimers();
    vi.setSystemTime(mintedAt + 119 * 60_000);
    const payload = await verifySessionToken(fakeEnv, token);
    expect(payload.sid).toBe('sess-long');
  });

  it('expires once the session lifetime plus grace has passed', async () => {
    const mintedAt = Date.now();
    const token = await mintSessionToken(fakeEnv, {
      sid: 'sess-long',
      uid: 'user-1',
      exp: sessionTokenExp(mintedAt + 120 * 60_000),
    });

    vi.useFakeTimers();
    vi.setSystemTime(mintedAt + 131 * 60_000);
    await expect(verifySessionToken(fakeEnv, token)).rejects.toThrow(/expired/);
  });
});
