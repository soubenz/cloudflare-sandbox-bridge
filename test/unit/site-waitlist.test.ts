import { describe, expect, it } from 'vitest';
import {
  errorLocation,
  normaliseEmail,
  parseSignup,
  UPSERT_SQL,
  upsertParams,
  type FieldSource,
} from '../../site/src/waitlist';

function form(fields: Record<string, string>): FieldSource {
  return { get: (name) => (name in fields ? fields[name] : null) };
}

describe('waitlist signup parsing', () => {
  it('normalises the email and keeps the chosen plan, role and source', () => {
    const r = parseSignup(form({ email: '  Ada@Example.COM ', plan: 'team', role: 'platform', source: 'Pricing' }));
    expect(r).toEqual({
      kind: 'signup',
      value: { email: 'ada@example.com', plan: 'team', role: 'platform', source: 'pricing' },
    });
  });

  it('defaults the plan to individual and treats role and source as optional', () => {
    const r = parseSignup(form({ email: 'ada@example.com' }));
    expect(r).toEqual({
      kind: 'signup',
      value: { email: 'ada@example.com', plan: 'individual', role: null, source: null },
    });
  });

  it('drops values that are not on the lists instead of storing them', () => {
    const r = parseSignup(form({ email: 'ada@example.com', plan: 'enterprise', role: '<script>', source: '../x' }));
    expect(r.kind).toBe('signup');
    if (r.kind !== 'signup') return;
    expect(r.value.plan).toBe('individual');
    expect(r.value.role).toBeNull();
    expect(r.value.source).toBeNull();
  });

  it('rejects a malformed email and remembers the plan for the retry', () => {
    expect(parseSignup(form({ email: 'not-an-email', plan: 'team' }))).toEqual({ kind: 'invalid', error: 'email', plan: 'team' });
    expect(parseSignup(form({ plan: 'team' }))).toEqual({ kind: 'invalid', error: 'email', plan: 'team' });
  });

  it('flags a filled honeypot before looking at anything else', () => {
    expect(parseSignup(form({ website: 'http://spam.example', email: 'bad' }))).toEqual({ kind: 'honeypot' });
  });

  it('ignores non-string values such as uploaded files', () => {
    const f: FieldSource = { get: (name) => (name === 'email' ? { name: 'file.txt' } : null) };
    expect(parseSignup(f).kind).toBe('invalid');
  });
});

describe('email normalisation', () => {
  it('accepts ordinary addresses, including plus tags and subdomains', () => {
    expect(normaliseEmail('a.b+opalix@mail.example.co.uk')).toBe('a.b+opalix@mail.example.co.uk');
  });

  it('rejects addresses without a domain dot, with spaces, or two @', () => {
    for (const bad of ['a@localhost', 'a b@example.com', 'a@@example.com', 'a@example.', '@example.com']) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it('rejects over-long addresses', () => {
    expect(normaliseEmail(`${'a'.repeat(65)}@example.com`)).toBeNull();
    expect(normaliseEmail(`a@${'b'.repeat(250)}.com`)).toBeNull();
  });
});

describe('storage', () => {
  it('upserts on email, keeping first-seen time and source', () => {
    expect(UPSERT_SQL).toMatch(/ON CONFLICT\(email\) DO UPDATE SET/);
    expect(UPSERT_SQL).not.toMatch(/created_at\s*=/);
    expect(UPSERT_SQL).not.toMatch(/source\s*=/);
    expect(UPSERT_SQL).toMatch(/role = COALESCE\(excluded\.role, waitlist\.role\)/);
  });

  it('binds parameters in the order the statement expects', () => {
    const p = upsertParams({ email: 'a@example.com', plan: 'team', role: null, source: 'hero' }, 'DE', 123);
    expect(p).toEqual(['a@example.com', 'team', null, 'DE', 'hero', 123]);
  });

  it('sends people back to the form with the error and their plan', () => {
    expect(errorLocation('slow', 'team')).toBe('/waitlist?e=slow&plan=team');
  });
});
