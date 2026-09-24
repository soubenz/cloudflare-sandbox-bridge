import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacePath } from '../../src/lib/paths';

describe('workspacePath', () => {
  it('keeps an ordinary relative path under the workspace', () => {
    expect(workspacePath('greeting.txt')).toBe('/workspace/greeting.txt');
    expect(workspacePath('src/deep/config.yml')).toBe('/workspace/src/deep/config.yml');
  });

  it('accepts the absolute workspace form the CLI and console send', () => {
    expect(workspacePath('/workspace')).toBe('/workspace');
    expect(workspacePath('/workspace/src')).toBe('/workspace/src');
  });

  it('refuses to climb out, however the traversal is spelled', () => {
    for (const bad of ['../../etc/passwd', '../etc/opalix/session.env', 'a/../../etc/passwd', '..']) {
      expect(() => workspacePath(bad)).toThrow(/inside \/workspace/);
    }
  });

  it('refuses an absolute path outside the workspace', () => {
    for (const bad of ['/etc/passwd', '/etc/opalix/session.env', '/workspaceother/x']) {
      expect(() => workspacePath(bad)).toThrow(/inside \/workspace/);
    }
  });

  it('refuses a null byte', () => {
    expect(() => workspacePath('ok.txt\0.png')).toThrow(/null byte/);
  });

  it('drops redundant segments rather than rejecting them', () => {
    expect(workspacePath('./a//b/')).toBe('/workspace/a/b');
  });
});

/**
 * The reason the guard has to exist, pinned so it cannot quietly stop being
 * true: Hono matches `:path{.+}` against the *encoded* path and decodes the
 * captured value afterwards, so `%2F` and `%2E` survive routing. Plain
 * `../` is normalised away by the URL parser and 404s, which is exactly why
 * the hole was invisible to the obvious probe.
 */
describe('the routing behaviour this guards against', () => {
  const app = new Hono();
  app.get('/sessions/:id/files/:path{.+}', (c) => c.text(c.req.param('path')));

  it('hands the handler a decoded traversal for an encoded request', async () => {
    const res = await app.request('http://x/sessions/s1/files/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('../../etc/passwd');
  });

  it('also decodes an encoded dot', async () => {
    const res = await app.request('http://x/sessions/s1/files/%2E%2E%2Fetc%2Fopalix%2Fsession.env');
    expect(await res.text()).toBe('../etc/opalix/session.env');
  });

  it('never sees an unencoded traversal, because the URL parser eats it first', async () => {
    const res = await app.request('http://x/sessions/s1/files/../../etc/passwd');
    expect(res.status).toBe(404);
  });
});
