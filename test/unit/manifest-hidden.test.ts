import { describe, it, expect } from 'vitest';
import { parseManifest, renderManifest, requireRunnable, hiddenPathSchema } from '../../src/labs/manifest';
import { summarizeManifest } from '../../src/session/state';

/**
 * Manifest `hidden` (src/labs/manifest.ts): workspace paths the console's file tree leaves out.
 * Relative to /workspace, a trailing slash for a folder, never able to point outside it; and
 * carried to the console in the session status's manifest_summary.
 */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'test-lab',
    version: '1.0.0',
    title: 'Test lab',
    type: 'build',
    family: 'agent',
    timeout_minutes: 60,
    services: [{ name: 'svc', argv: ['python3', '-m', 'http.server'], port: 8000 }],
    checks: [{ name: 'check-1', script: 'check.sh' }],
    ...overrides,
  };
}

describe('manifest hidden', () => {
  it('is optional: a manifest without it parses and hides nothing', () => {
    expect(parseManifest(manifest()).hidden).toBeUndefined();
  });

  it.each([
    'services/',
    'services/fake_provider.py',
    'view.py',
    'gateway/hooks/seed.py',
    'dashboard/provisioning/',
    '.hidden-config.yaml',
    'a..b/c.py',
  ])('accepts %j', (entry) => {
    expect(parseManifest(manifest({ hidden: [entry] })).hidden).toEqual([entry]);
  });

  it.each([
    ['/workspace/services/x.py', 'not absolute'],
    ['/etc/passwd', 'not absolute'],
    ['../secrets.txt', '".."'],
    ['services/../../etc/', '".."'],
    ['services//x.py', 'empty or "." segment'],
    ['./x.py', 'empty or "." segment'],
    ['services\\x.py', 'forward slashes'],
    ['services/*.py', 'wildcards'],
    ['', 'at least 1'],
  ])('refuses %j (%s)', (entry, why) => {
    expect(() => parseManifest(manifest({ hidden: [entry] }))).toThrow(why);
    expect(hiddenPathSchema.safeParse(entry).success).toBe(false);
  });

  it('refuses something that is not a list of strings', () => {
    expect(() => parseManifest(manifest({ hidden: 'services/' }))).toThrow(/hidden/);
    expect(() => parseManifest(manifest({ hidden: [42] }))).toThrow(/hidden/);
  });

  it('is refused on a warm-up, which has no workspace', () => {
    const warmUp = { slug: 'first-steps', version: '1.0.0', title: 'First steps', type: 'warm-up', tier: 'free', difficulty: 'intro', estimated_minutes: 10 };
    expect(() => parseManifest({ ...warmUp, hidden: ['x.py'] })).toThrow('a warm-up has no workspace, so nothing to hide');
    expect(() => parseManifest({ ...warmUp, hidden: [] })).not.toThrow();
  });

  it('survives rendering for a session and reaches the console in manifest_summary', () => {
    const m = requireRunnable(parseManifest(manifest({ hidden: ['services/', 'view.py'] })));
    const rendered = renderManifest(m, 'sess', 'https://x', 'llm');
    expect(rendered.hidden).toEqual(['services/', 'view.py']);
    expect(summarizeManifest(rendered).hidden).toEqual(['services/', 'view.py']);
  });

  it('leaves manifest_summary without the key when the lab hides nothing', () => {
    expect('hidden' in summarizeManifest(requireRunnable(parseManifest(manifest())))).toBe(false);
    expect('hidden' in summarizeManifest(requireRunnable(parseManifest(manifest({ hidden: [] }))))).toBe(false);
  });
});
