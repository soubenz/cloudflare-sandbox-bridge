import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Admin mode's pure parts (dashboard/src/admin-mode.js): who is allowed it, how the stored flag is read and
 * cleared, what the Admin strip may show, and the scrubbing of the live event log. The Worker's `can_admin`
 * is tested in console-worker.test.ts; the screens in test/e2e/23-admin-mode.spec.ts.
 */
const mod = (await import('../../dashboard/src/admin-mode.js' as string)) as {
  ADMIN_KEY: string;
  LOCK_NOTE: string;
  DEFAULT_ADMIN_URL: string;
  MAX_EVENTS: number;
  resolveAdmin: (x: { canAdmin: unknown; stored: string | null | undefined }) => { on: boolean; clear: boolean };
  adminHref: (v: unknown) => string;
  redact: (v: unknown, secrets?: string[]) => unknown;
  eventLine: (e: { at: number; type: string; data?: unknown }) => { time: string; type: string; body: string };
  sessionRows: (info?: Record<string, unknown>) => Array<{ key: string; label: string; value: string; copy: string }>;
  createAdminState: (o?: { storage?: Storage }) => {
    configure: (me?: { canAdmin?: unknown; adminUrl?: unknown }) => void;
    can: () => boolean;
    isOn: () => boolean;
    href: () => string;
    set: (on: boolean) => boolean;
    subscribe: (fn: (s: { can: boolean; on: boolean; changed: boolean }) => void) => () => boolean;
  };
};
const { ADMIN_KEY, resolveAdmin, adminHref, redact, eventLine, sessionRows, createAdminState } = mod;

/** A localStorage stand-in. */
function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } as unknown as Storage,
  };
}
const blocked = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('resolveAdmin: the server decides who may have it, the stored flag only says whether they want it', () => {
  it('is on only for can_admin === true with the flag on', () => {
    expect(resolveAdmin({ canAdmin: true, stored: '1' })).toEqual({ on: true, clear: false });
    expect(resolveAdmin({ canAdmin: true, stored: null })).toEqual({ on: false, clear: false });
    expect(resolveAdmin({ canAdmin: true, stored: '0' })).toEqual({ on: false, clear: false });
  });
  it('ignores and clears a stored "on" when can_admin is not true (false, absent, or anything else)', () => {
    for (const canAdmin of [false, undefined, null, 'true', 1, {}]) {
      expect(resolveAdmin({ canAdmin, stored: '1' }), String(canAdmin)).toEqual({ on: false, clear: true });
    }
    expect(resolveAdmin({ canAdmin: false, stored: null })).toEqual({ on: false, clear: false });
  });
});

describe('createAdminState', () => {
  it('starts off, and is off until /api/me has been heard', () => {
    const { storage } = memory({ [ADMIN_KEY]: '1' });
    const s = createAdminState({ storage });
    expect(s.can()).toBe(false);
    expect(s.isOn()).toBe(false);
  });

  it('can_admin true with the flag stored: on', () => {
    const { storage } = memory({ [ADMIN_KEY]: '1' });
    const s = createAdminState({ storage });
    s.configure({ canAdmin: true });
    expect(s.can()).toBe(true);
    expect(s.isOn()).toBe(true);
  });

  it('can_admin false with the flag stored: off, and the stored flag is removed', () => {
    const { storage, map } = memory({ [ADMIN_KEY]: '1' });
    const s = createAdminState({ storage });
    s.configure({ canAdmin: false });
    expect(s.isOn()).toBe(false);
    expect(map.has(ADMIN_KEY)).toBe(false);
    // And it stays gone if a later answer says yes: it has to be switched on again on purpose.
    s.configure({ canAdmin: true });
    expect(s.isOn()).toBe(false);
  });

  it('an absent can_admin is the same as false', () => {
    const { storage, map } = memory({ [ADMIN_KEY]: '1' });
    const s = createAdminState({ storage });
    s.configure({});
    expect(s.can()).toBe(false);
    expect(map.has(ADMIN_KEY)).toBe(false);
  });

  it('cannot be switched on when not allowed, and writes nothing', () => {
    const { storage, map } = memory();
    const s = createAdminState({ storage });
    expect(s.set(true)).toBe(false);
    s.configure({ canAdmin: false });
    expect(s.set(true)).toBe(false);
    expect(s.isOn()).toBe(false);
    expect(map.size).toBe(0);
  });

  it('the switch is remembered, and switching off removes the flag', () => {
    const { storage, map } = memory();
    const s = createAdminState({ storage });
    s.configure({ canAdmin: true });
    s.set(true);
    expect(map.get(ADMIN_KEY)).toBe('1');
    expect(createAdminState({ storage }).isOn()).toBe(false); // not configured yet: nothing is believed
    const again = createAdminState({ storage });
    again.configure({ canAdmin: true });
    expect(again.isOn()).toBe(true);
    again.set(false);
    expect(map.has(ADMIN_KEY)).toBe(false);
  });

  it('tells its listeners what changed', () => {
    const { storage } = memory({ [ADMIN_KEY]: '1' });
    const s = createAdminState({ storage });
    const seen: Array<{ can: boolean; on: boolean; changed: boolean }> = [];
    const stop = s.subscribe((x) => seen.push(x));
    s.configure({ canAdmin: true });
    s.set(false);
    s.set(false);
    stop();
    s.set(true);
    expect(seen).toEqual([
      { can: true, on: true, changed: true },
      { can: true, on: false, changed: true },
      { can: true, on: false, changed: false },
    ]);
  });

  it('works with storage that throws (private mode): this tab only', () => {
    const s = createAdminState({ storage: blocked });
    expect(() => s.configure({ canAdmin: true })).not.toThrow();
    expect(s.isOn()).toBe(false);
    expect(() => s.set(true)).not.toThrow();
    expect(s.isOn()).toBe(true);
    expect(() => createAdminState({ storage: blocked }).configure({ canAdmin: false })).not.toThrow();
  });

  it('takes the admin Worker address only as an https origin', () => {
    const s = createAdminState({ storage: memory().storage });
    s.configure({ canAdmin: true, adminUrl: 'https://admin.example.com/x' });
    expect(s.href()).toBe('https://admin.example.com');
    s.configure({ canAdmin: true, adminUrl: 'javascript:alert(1)' });
    expect(s.href()).toBe(mod.DEFAULT_ADMIN_URL);
  });
});

describe('adminHref', () => {
  it('keeps an https origin or localhost and falls back to the default for anything else', () => {
    expect(adminHref('https://a.example')).toBe('https://a.example');
    expect(adminHref('http://localhost:8790/x')).toBe('http://localhost:8790');
    for (const bad of [undefined, null, '', 'nope', 'http://a.example', 'javascript:1', 'data:text/html,x']) expect(adminHref(bad), String(bad)).toBe(mod.DEFAULT_ADMIN_URL);
  });
});

describe('the Admin strip never holds a token', () => {
  it('builds its rows from named fields only: a token handed in is not read', () => {
    const rows = sessionRows({ id: 'S1', userId: 'console', lab: 'hello', version: '1.2.0', state: 'running', expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5), token: 'SECRET.TOKEN-VALUE-1234567890', sessionToken: 'also-secret' });
    expect(rows.map((r) => r.label)).toEqual(['Session id', 'User id', 'Lab and version', 'State', 'Expires at']);
    expect(rows.map((r) => r.copy)).toEqual(['S1', 'console', 'hello@1.2.0', 'running', '2026-01-02T03:04:05.000Z']);
    expect(JSON.stringify(rows)).not.toMatch(/secret|token-value|also-secret/i);
  });
  it('shows a dash, and copies nothing, for what is not known yet', () => {
    const rows = sessionRows({});
    expect(rows.every((r) => r.value === '—' && r.copy === '')).toBe(true);
    expect(sessionRows({ lab: 'hello' })[2]!.copy).toBe('hello');
  });
  it('the console hands the strip no token (the hook lists its fields)', () => {
    const app = readFileSync(new URL('../../dashboard/src/app.js', import.meta.url), 'utf8');
    const hook = app.slice(app.indexOf('adminMode.init({'), app.indexOf('getSecrets')).replace(/\/\/.*$/gm, '');
    expect(hook).toContain('getSession');
    expect(hook).not.toMatch(/token/i);
  });
});

describe('redact: the live event log hides credentials', () => {
  const TOKEN = 'eyJzaWQiOiIwMUo5In0.QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo';
  it('hides anything named like a credential, but keeps counts and flags', () => {
    expect(redact({ token: TOKEN, session_token: 'x', authorization: 'Bearer y', password: 'p', cookie: 'c', api_key: 'k', ok: true, tokens_in: 120, name: 'a check' })).toEqual({
      token: '[hidden]',
      session_token: '[hidden]',
      authorization: '[hidden]',
      password: '[hidden]',
      cookie: '[hidden]',
      api_key: '[hidden]',
      ok: true,
      tokens_in: 120,
      name: 'a check',
    });
  });
  it('hides the session token wherever it turns up: inside a string, in a url, or on its own, and in nested data', () => {
    const out = JSON.stringify(
      redact(
        { url: `https://api.example/sessions/S1/events?token=${TOKEN}&x=1`, line: `curl -H "x: ${TOKEN}"`, bare: TOKEN, nested: { deeper: [{ v: `a ${TOKEN} b` }] } },
        [TOKEN]
      )
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('QUJDREVG');
    expect(out).toContain('[hidden]');
    expect(out).toContain('x=1');
  });
  it('hides a token-shaped string even when it was never told the token', () => {
    expect(redact(TOKEN)).toBe('[hidden]');
    expect(redact('see-what-a-gateway-does')).toBe('see-what-a-gateway-does');
    expect(redact('opalix-sandbox.soubenz94.workers.dev')).toBe('opalix-sandbox.soubenz94.workers.dev');
  });
  it('bounds what it keeps', () => {
    const big = redact({ list: Array.from({ length: 100 }, (_, i) => i), text: 'x'.repeat(1000), deep: { a: { b: { c: { d: { e: 1 } } } } } }) as { list: number[]; text: string; deep: unknown };
    expect(big.list).toHaveLength(20);
    expect(big.text.length).toBeLessThanOrEqual(241);
    expect(JSON.stringify(big.deep)).toContain('…');
  });
  it('passes plain values through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(3)).toBe(3);
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('eventLine', () => {
  it('is a time, a type and a short body', () => {
    expect(eventLine({ at: Date.UTC(2026, 0, 1, 12, 0, 1), type: 'check.result', data: { name: 'a', pass: true } })).toEqual({ time: '12:00:01', type: 'check.result', body: '{"name":"a","pass":true}' });
    expect(eventLine({ at: 0, type: 'session.state' }).body).toBe('');
    expect(eventLine({ at: 0, type: 'x', data: { t: 'y'.repeat(400) } }).body.length).toBeLessThanOrEqual(301);
  });
});
