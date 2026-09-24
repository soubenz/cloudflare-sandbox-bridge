import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLM_HOST, MIRROR_HOST } from '../../src/families/egress';

/**
 * families/egress.ts documents that LLM_HOST/MIRROR_HOST must be literal
 * strings kept in sync with wrangler.jsonc's vars by hand, because the
 * Sandbox subclass's `allowedHosts`/`outboundByHost` can't read `env` at
 * module-load time. This test is that sync check.
 */
function readWranglerVars(): Record<string, string> {
  const raw = readFileSync(join(__dirname, '../../wrangler.jsonc'), 'utf8');
  // Strip // comments (JSONC) before parsing — good enough for this file's contents.
  // Only strip a `//` that is a real line comment (preceded by whitespace),
  // never one inside a URL scheme like "https://..." (preceded by ':').
  const withoutComments = raw
    .split('\n')
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
  const parsed = JSON.parse(withoutComments);
  return parsed.vars;
}

describe('egress hostname constants stay in sync with wrangler.jsonc', () => {
  const vars = readWranglerVars();

  it('LLM_HOST matches the production wrangler.jsonc var', () => {
    expect(LLM_HOST).toBe(vars.LLM_HOST);
  });

  it('MIRROR_HOST matches the production wrangler.jsonc var', () => {
    expect(MIRROR_HOST).toBe(vars.MIRROR_HOST);
  });
});

describe('egress fence wiring', () => {
  // @cloudflare/containers reads `this.enableInternet` and
  // `this.allowedHosts` — instance fields. Declaring either as `static` is
  // silently ignored, which is exactly what happened: the fence looked
  // correct in the source and the container had unrestricted internet.
  // Only `outboundByHost` is genuinely static (registry-backed).
  it.each(['AgentLab', 'GatewayLab'])('%s declares the egress fields as instance fields', (cls) => {
    const src = readFileSync(
      join(__dirname, `../../src/families/${cls === 'AgentLab' ? 'agent' : 'gateway'}-lab.ts`),
      'utf8'
    );
    expect(src).toMatch(/^\s{2}enableInternet = false;$/m);
    expect(src).toMatch(/^\s{2}allowedHosts = BASE_ALLOWED_HOSTS;$/m);
    expect(src).not.toMatch(/static\s+enableInternet/);
    expect(src).not.toMatch(/static\s+allowedHosts/);
    // This one must stay static.
    expect(src).toMatch(/static outboundByHost/);
  });
});
