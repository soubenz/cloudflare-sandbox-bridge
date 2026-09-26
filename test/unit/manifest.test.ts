import { describe, it, expect } from 'vitest';
import { parseManifest, renderTemplate, renderManifest, labManifestSchema } from '../../src/labs/manifest';
import { topoOrder } from '../../src/session/services';

function baseManifest(overrides: Record<string, unknown> = {}) {
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

describe('parseManifest', () => {
  it('accepts a minimal valid manifest and fills defaults', () => {
    const m = parseManifest(baseManifest());
    expect(m.idle_minutes).toBe(10);
    expect(m.services[0]!.cwd).toBe('/workspace');
    expect(m.egress.allow).toEqual([]);
  });

  it('rejects a bad slug', () => {
    expect(() => parseManifest(baseManifest({ slug: 'Not Valid!' }))).toThrow(/slug/);
  });

  it('rejects timeout_minutes below 60', () => {
    expect(() => parseManifest(baseManifest({ timeout_minutes: 30 }))).toThrow();
  });

  it('accepts a valid manifest with type: explore', () => {
    expect(() => parseManifest(baseManifest({ type: 'explore' }))).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => parseManifest(baseManifest({ type: 'nonsense' }))).toThrow();
  });

  it('rejects a services[].depends_on referencing an unknown service', () => {
    const bad = baseManifest({
      services: [{ name: 'a', argv: ['x'], depends_on: ['nonexistent'] }],
    });
    expect(() => parseManifest(bad)).toThrow(/unknown service/);
  });

  // The SDK's validatePort accepts 1024-65535 excluding 3000, and every SDK
  // entry point that takes a port throws SandboxSecurityError otherwise, so
  // a manifest that passes publish with port 80/443/3000 only fails later,
  // at session start, inside a container.
  describe('services[].port', () => {
    const withPort = (port: number) => baseManifest({ services: [{ name: 'svc', argv: ['x'], port }] });

    it('rejects privileged ports the container cannot bind', () => {
      expect(() => parseManifest(withPort(80))).toThrow(/privileged/);
      expect(() => parseManifest(withPort(443))).toThrow(/1024-65535/);
    });

    it('rejects port 3000 and names the sandbox control plane', () => {
      expect(() => parseManifest(withPort(3000))).toThrow(/sandbox control plane/);
    });

    it('accepts the boundaries of the SDK-allowed range', () => {
      expect(parseManifest(withPort(1024)).services[0]!.port).toBe(1024);
      expect(parseManifest(withPort(65535)).services[0]!.port).toBe(65535);
    });

    it('still rejects ports above the range and non-integers', () => {
      expect(() => parseManifest(withPort(65536))).toThrow(/1024-65535/);
      expect(() => parseManifest(withPort(8080.5))).toThrow();
    });
  });

  it('accepts a valid depends_on chain', () => {
    const good = baseManifest({
      services: [
        { name: 'db', argv: ['x'] },
        { name: 'app', argv: ['y'], depends_on: ['db'] },
      ],
    });
    expect(() => parseManifest(good)).not.toThrow();
  });
});

describe('labManifestSchema safeParse', () => {
  it('flags multiple errors at once', () => {
    const result = labManifestSchema.safeParse(baseManifest({ slug: '', checks: [] }));
    expect(result.success).toBe(false);
  });
});

describe('renderTemplate', () => {
  const ctx = { session: { id: 'abc123', base_url: 'https://x.test' }, service: { prefix: '/sessions/abc123/services/grafana' }, llm: { host: 'llm.test' } };

  it('substitutes known variables', () => {
    expect(renderTemplate('{{session.id}}', ctx)).toBe('abc123');
    expect(renderTemplate('{{service.prefix}}/api', ctx)).toBe('/sessions/abc123/services/grafana/api');
    expect(renderTemplate('http://{{llm.host}}', ctx)).toBe('http://llm.test');
  });

  it('throws on an unknown variable', () => {
    expect(() => renderTemplate('{{nope.nope}}', ctx)).toThrow(/Unknown template variable/);
  });

  it('leaves plain text untouched', () => {
    expect(renderTemplate('no templates here', ctx)).toBe('no templates here');
  });
});

describe('renderManifest', () => {
  it('renders templates in services and env for a concrete session', () => {
    const manifest = parseManifest(
      baseManifest({
        env: { LLM_URL: 'http://{{llm.host}}' },
        services: [{ name: 'gw', argv: ['run', '--prefix', '{{service.prefix}}'], env: { SID: '{{session.id}}' } }],
      })
    );
    const rendered = renderManifest(manifest, 'sess-1', 'https://api.test', 'llm.opalix.ai');
    expect(rendered.env.LLM_URL).toBe('http://llm.opalix.ai');
    expect(rendered.services[0]!.argv).toEqual(['run', '--prefix', '/sessions/sess-1/services/gw']);
    expect(rendered.services[0]!.env.SID).toBe('sess-1');
  });

  it('templates pressure copy, hints, egress hosts and healthcheck paths', () => {
    // These are author-facing strings; an un-rendered one reaches the
    // learner as a literal {{session.base_url}} or silently matches no host.
    const rendered = renderManifest(
      parseManifest(
        baseManifest({
          services: [
            { name: 'svc', argv: ['x'], port: 8000, healthcheck: { type: 'http', path: '{{service.prefix}}/health' } },
          ],
          pressure: [
            { id: 'p', at_minutes: 1, argv: ['x'], title: 'At {{session.id}}', message: 'See {{session.base_url}}' },
          ],
          hints: [{ after_minutes: 1, text: 'Open {{session.base_url}}' }],
          egress: { allow: ['{{llm.host}}'] },
        })
      ),
      'sess-1',
      'https://api.example.com',
      'llm.example.com'
    );
    expect(rendered.pressure[0]!.title).toBe('At sess-1');
    expect(rendered.pressure[0]!.message).toBe('See https://api.example.com');
    expect(rendered.hints[0]!.text).toBe('Open https://api.example.com');
    expect(rendered.egress.allow).toEqual(['llm.example.com']);
    expect(rendered.services[0]!.healthcheck!.path).toBe('/sessions/sess-1/services/svc/health');
  });
});

describe('topoOrder', () => {
  it('orders services before their dependents', () => {
    const manifest = parseManifest(
      baseManifest({
        services: [
          { name: 'c', argv: ['x'], depends_on: ['a', 'b'] },
          { name: 'a', argv: ['x'] },
          { name: 'b', argv: ['x'], depends_on: ['a'] },
        ],
      })
    );
    const order = topoOrder(manifest.services).map((s) => s.name);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('returns a single service unchanged', () => {
    const manifest = parseManifest(baseManifest());
    expect(topoOrder(manifest.services).map((s) => s.name)).toEqual(['svc']);
  });

  it('tolerates a dependency listed twice', () => {
    // A duplicate used to raise indegree twice and be decremented once,
    // reporting a dependency cycle that does not exist.
    const manifest = parseManifest(
      baseManifest({
        services: [
          { name: 'b', argv: ['x'], depends_on: ['a', 'a'] },
          { name: 'a', argv: ['x'] },
        ],
      })
    );
    expect(topoOrder(manifest.services).map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('services: cross-field rules', () => {
  const base = {
    slug: 'x-lab',
    version: '1.0.0',
    title: 'X',
    type: 'build',
    family: 'agent',
    timeout_minutes: 60,
    checks: [{ name: 'c', script: 'c.sh' }],
  };

  it('rejects two services declaring the same port', () => {
    expect(() =>
      parseManifest({
        ...base,
        services: [
          { name: 'a', argv: ['a'], port: 8080 },
          { name: 'b', argv: ['b'], port: 8080 },
        ],
      })
    ).toThrow(/both declare port 8080/);
  });

  it('allows two services when only one declares a port', () => {
    expect(() =>
      parseManifest({
        ...base,
        services: [
          { name: 'a', argv: ['a'], port: 8080 },
          { name: 'b', argv: ['b'] },
        ],
      })
    ).not.toThrow();
  });

  it('rejects ui: true with no port, which the proxy can only 400 on', () => {
    expect(() =>
      parseManifest({ ...base, services: [{ name: 'a', argv: ['a'], ui: true }] })
    ).toThrow(/marked ui: true but declares no port/);
  });
});
