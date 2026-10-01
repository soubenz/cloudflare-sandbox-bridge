import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';

/**
 * Signing in returns to the page that was asked for (dashboard/src/return-path.js, the Worker that
 * serves the form, and public/login.js that follows it). The address is attacker-controllable text, so
 * the point of these tests is what is refused: an open redirect through a sign-in link is the
 * classic mistake.
 */
const rp = (await import('../../dashboard/src/return-path.js' as string)) as {
  safeReturnPath: (raw: unknown) => string;
  returnPathFor: (url: URL) => string;
};
const safe = rp.safeReturnPath;

describe('safeReturnPath', () => {
  it('keeps a same-origin path, with its query', () => {
    for (const ok of ['/', '/labs/x1', '/labs/x1/session', '/labs/x1/session/service/echo', '/paths/ai-platform/modules/2', '/onboarding', '/labs/x1/lessons?comicTest=1', '/some/unknown/page']) {
      expect(safe(ok), ok).toBe(ok);
    }
    expect(safe('/labs/x1#frag')).toBe('/labs/x1');
    expect(safe('/labs/x1/../x2')).toBe('/labs/x2');
  });

  it('refuses everything that could leave the origin', () => {
    const hostile = [
      '//evil.example',
      '//evil.example/labs/x1',
      '///evil.example',
      '////evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '\\/evil.example',
      '/\\/evil.example',
      'https://evil.example',
      'http://evil.example/labs/x1',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'evil.example',
      'labs/x1',
      '',
      ' /labs/x1',
      // Dot segments that collapse into a protocol-relative path.
      '/.//evil.example',
      '/./\\evil.example',
      '/a/..//evil.example',
      // Controls the browser strips, or that split a header, raw or encoded.
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n/evil.example',
      '/\u0000/evil.example',
      '/%09/evil.example',
      '/%0a/evil.example',
      '/%5cevil.example',
      '/%5Cevil.example',
      '/labs/x1\\..\\..\\evil',
      '/%00',
      // Not valid escapes are not guessed at.
      '/%E0%A4%A',
      '/%',
    ];
    for (const bad of hostile) expect(safe(bad), JSON.stringify(bad)).toBe('/');
    // A protocol-relative address after one more decode is not smuggled through either.
    expect(safe('/%2F%2Fevil.example')).not.toMatch(/^\/\//);
  });

  it('ignores the Worker\'s own paths', () => {
    for (const own of ['/auth/login', '/auth/logout', '/auth', '/api/labs', '/api', '/api/start', '/dist/app.js', '/login.js']) expect(safe(own), own).toBe('/');
    // But a lab that merely starts with the letters is a lab.
    expect(safe('/authors')).toBe('/authors');
    expect(safe('/apiary/x')).toBe('/apiary/x');
  });

  it('never throws, and refuses what is not a string or is absurdly long', () => {
    for (const junk of [undefined, null, 0, 1, true, {}, [], ['/labs/x1'], () => '/']) expect(safe(junk), String(junk)).toBe('/');
    expect(safe(`/${'a'.repeat(5000)}`)).toBe('/');
    expect(safe(`/labs/${'a'.repeat(100)}`)).toBe(`/labs/${'a'.repeat(100)}`);
  });

  it('does not carry a next parameter forward (no redirect chains)', () => {
    expect(safe('/labs/x1?next=/labs/x2')).toBe('/labs/x1');
    expect(safe('/labs/x1?a=1&next=//evil.example&b=2')).toBe('/labs/x1?a=1&b=2');
  });
});

describe('returnPathFor', () => {
  const f = (path: string) => rp.returnPathFor(new URL(path, 'https://console.test'));

  it('is the page that was asked for', () => {
    expect(f('/labs/x1/session')).toBe('/labs/x1/session');
    expect(f('/labs/x1/session?a=1')).toBe('/labs/x1/session?a=1');
    expect(f('/')).toBe('/');
  });

  it('honours a valid ?next=, and a bad one means "/", never the rest of the URL', () => {
    expect(f('/?next=/labs/x1/lessons')).toBe('/labs/x1/lessons');
    expect(f('/labs/x1?next=/labs/x2')).toBe('/labs/x2');
    expect(f('/labs/x1?next=//evil.example')).toBe('/');
    expect(f('/labs/x1?next=https://evil.example')).toBe('/');
    expect(f('/labs/x1?next=%2F%2Fevil.example')).toBe('/');
    expect(f('/labs/x1?next=%5C%5Cevil.example')).toBe('/');
    expect(f('/labs/x1?next=/auth/logout')).toBe('/');
    expect(f('/labs/x1?next=')).toBe('/');
  });

  it('never returns to an /api or /auth address', () => {
    expect(f('/auth/logout')).toBe('/');
    expect(f('/api/me')).toBe('/');
  });
});

describe('public/login.js', () => {
  /** Runs the page's script against a stand-in document and reports where it sent the browser. */
  async function signIn(meta: string | null, at = '/labs/x1/session', ok = true) {
    const sent: string[] = [];
    let submit: ((e: { preventDefault: () => void }) => Promise<void>) | undefined;
    const el = (id: string) => ({ value: 'pw', textContent: '', addEventListener: (_t: string, l: typeof submit) => (submit = l), id });
    const doc = {
      getElementById: el,
      querySelector: (sel: string) => (sel === 'meta[name="return-to"]' && meta !== null ? { getAttribute: () => meta } : null),
    };
    const location = {
      pathname: at.split('?')[0],
      search: at.includes('?') ? `?${at.split('?')[1]}` : '',
      reload: () => sent.push('reload'),
      replace: (u: string) => sent.push(u),
    };
    const fetchStub = async () => ({ ok, status: ok ? 204 : 401 });
    runInNewContext(readFileSync('dashboard/public/login.js', 'utf8'), { document: doc, location, fetch: fetchStub, JSON, console });
    await submit!({ preventDefault: () => {} });
    return sent;
  }

  it('reloads when the page named is the one the form is on', async () => {
    expect(await signIn('/labs/x1/session', '/labs/x1/session')).toEqual(['reload']);
    expect(await signIn('/labs/x1/session?a=1', '/labs/x1/session?a=1')).toEqual(['reload']);
  });

  it('goes to the page named when it is another one', async () => {
    expect(await signIn('/labs/x2/lessons', '/')).toEqual(['/labs/x2/lessons']);
  });

  it('checks the target again: nothing but a same-origin path is followed', async () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '\\evil.example', '/\t/evil.example', 'javascript:alert(1)']) {
      expect(await signIn(bad, '/labs/x1'), JSON.stringify(bad)).toEqual(['/']);
    }
    expect(await signIn(null, '/labs/x1')).toEqual(['/']);
  });

  it('does nothing about the address when the password is wrong', async () => {
    expect(await signIn('/labs/x1', '/labs/x1', false)).toEqual([]);
  });
});
