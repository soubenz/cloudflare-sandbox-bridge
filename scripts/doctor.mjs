#!/usr/bin/env node
// Local preflight for operators and contributors. Prints one PASS/WARN/FAIL
// line per check and exits 1 if any check FAILs. Checks your tooling, env and
// repo consistency; it does not call production. See docs/runbooks/incident.md.
// No dependencies beyond node_modules/jsonc-parser (a devDependency).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(root, p);
const require = createRequire(import.meta.url);

const results = [];
function report(level, name, detail) {
  results.push(level);
  console.log(`${level.padEnd(4)}  ${name}${detail ? ': ' + detail : ''}`);
}
const pass = (n, d) => report('PASS', n, d);
const warn = (n, d) => report('WARN', n, d);
const fail = (n, d) => report('FAIL', n, d);

function run(cmd, args, timeout = 60000) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return { ok: r.status === 0, out, error: r.error };
}

function check(name, fn) {
  try {
    fn(name);
  } catch (err) {
    fail(name, `check crashed: ${err.message}`);
  }
}

const versionParts = (v) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
function gte(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

// Lowest version a semver range allows, e.g. ">=20.11" -> "20.11", "^22" -> "22".
function minVersion(range) {
  const m = /(\d+(?:\.\d+){0,2})/.exec(range);
  return m ? m[1] : null;
}

// 1. Node version
check('node version', (name) => {
  const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));
  const range = pkg.engines?.node;
  const want = (range && minVersion(range)) || '20';
  const source = range ? `engines.node "${range}"` : 'default, no engines in package.json';
  if (gte(process.versions.node, want)) pass(name, `${process.versions.node} >= ${want} (${source})`);
  else fail(name, `${process.versions.node} < ${want} (${source})`);
});

// 2. wrangler whoami
check('wrangler whoami', (name) => {
  const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const r = run('npx', ['--no-install', 'wrangler', 'whoami'], 90000);
  // wrangler exits 0 even when logged out, so read the output too.
  const authenticated = r.ok && !/not authenticated/i.test(r.out);
  if (authenticated) {
    pass(name, hasToken ? 'authenticated (CLOUDFLARE_API_TOKEN set)' : 'authenticated');
  } else if (!hasToken) {
    warn(name, 'not authenticated and CLOUDFLARE_API_TOKEN is not set; wrangler commands that hit Cloudflare will fail');
  } else {
    fail(name, `wrangler whoami failed with CLOUDFLARE_API_TOKEN set: ${(r.out.split('\n').find((l) => /error|invalid|authenticat/i.test(l)) || 'see wrangler log').trim()}`);
  }
});

// 3. docker
check('docker', (name) => {
  const r = run('docker', ['version', '--format', '{{.Client.Version}}'], 20000);
  if (r.ok) pass(name, `client ${r.out}`);
  else warn(name, 'docker not available; needed only to build container images locally (CI builds them)');
});

// 4. .dev.vars.example vs src/env.ts
check('env keys', (name) => {
  const example = readFileSync(rel('.dev.vars.example'), 'utf8');
  const exampleKeys = new Set(
    example
      .split('\n')
      .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]),
  );

  const envSrc = readFileSync(rel('src/env.ts'), 'utf8');
  const body = /export\s+interface\s+Env\s*\{([\s\S]*?)\n\}/.exec(envSrc);
  if (!body) return fail(name, 'could not find `export interface Env` in src/env.ts');
  const fields = [...body[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)(\??):\s*([^;]+);/gm)].map((m) => ({
    key: m[1],
    optional: m[2] === '?',
    type: m[3].trim(),
  }));
  const envKeys = new Set(fields.map((f) => f.key));

  // Keys that wrangler.jsonc supplies (vars and bindings) do not belong in .dev.vars.
  const cfg = readWrangler();
  const fromWrangler = new Set([
    ...Object.keys(cfg.vars ?? {}),
    ...(cfg.durable_objects?.bindings ?? []).map((b) => b.name),
    ...(cfg.r2_buckets ?? []).map((b) => b.binding),
    ...(cfg.d1_databases ?? []).map((b) => b.binding),
  ]);

  const problems = [];
  for (const k of exampleKeys) {
    if (!envKeys.has(k)) problems.push(`${k} is in .dev.vars.example but not in the Env type`);
  }
  for (const f of fields) {
    if (f.optional || fromWrangler.has(f.key) || exampleKeys.has(f.key)) continue;
    problems.push(`${f.key} is required in the Env type but is in neither .dev.vars.example nor wrangler.jsonc`);
  }
  const optionalUnlisted = fields.filter((f) => f.optional && !exampleKeys.has(f.key) && !fromWrangler.has(f.key)).map((f) => f.key);

  if (problems.length) fail(name, problems.join('; '));
  else pass(name, `${exampleKeys.size} keys in .dev.vars.example all in Env; every required secret is covered` + (optionalUnlisted.length ? ` (optional, not in example: ${optionalUnlisted.join(', ')})` : ''));
});

// 5. OPALIX_URL / OPALIX_KEY
check('OPALIX_URL / OPALIX_KEY', (name) => {
  const missing = ['OPALIX_URL', 'OPALIX_KEY'].filter((k) => !process.env[k]);
  if (missing.length) warn(name, `${missing.join(' and ')} not set in this shell; the CLI, probes and integration tests need both`);
  else pass(name, 'both set');
});

// 6. opalix-init.sh copies
check('opalix-init.sh copies', (name) => {
  const find = run('find', ['images', '-name', 'opalix-init.sh']);
  const paths = find.out.split('\n').filter(Boolean).sort();
  if (!find.ok || paths.length < 2) return fail(name, `expected copies under images/, found: ${paths.join(', ') || 'none'}`);
  const bufs = paths.map((p) => readFileSync(rel(p)));
  const canonical = paths.indexOf('images/common/opalix-init.sh');
  const base = canonical >= 0 ? canonical : 0;
  const differing = paths.filter((_, i) => !bufs[i].equals(bufs[base]));
  if (differing.length) fail(name, `differs from ${paths[base]}: ${differing.join(', ')}; edit all copies (images/common/README.md)`);
  else pass(name, `${paths.length} copies byte-identical (${paths.join(', ')})`);
});

// 7. wrangler.jsonc container classes vs registry and DO bindings
check('container classes', (name) => {
  const cfg = readWrangler();
  const containers = cfg.containers ?? [];
  if (!containers.length) return fail(name, 'no containers[] in wrangler.jsonc');
  const registry = readFileSync(rel('src/families/registry.ts'), 'utf8');
  const bindings = cfg.durable_objects?.bindings ?? [];
  const problems = [];
  for (const c of containers) {
    const cls = c.class_name;
    if (!new RegExp(`\\b${cls}\\b`).test(registry)) problems.push(`${cls} not found in src/families/registry.ts`);
    const b = bindings.find((x) => x.class_name === cls);
    if (!b) problems.push(`${cls} has no durable_objects.bindings entry`);
    else if (!registry.includes(`'${b.name}'`)) problems.push(`binding ${b.name} (${cls}) not referenced in src/families/registry.ts`);
  }
  if (problems.length) fail(name, problems.join('; '));
  else pass(name, `${containers.map((c) => c.class_name).join(', ')} present in registry.ts and durable_objects.bindings`);
});

function readWrangler() {
  const { parse } = require('jsonc-parser');
  const errors = [];
  const cfg = parse(readFileSync(rel('wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`wrangler.jsonc has ${errors.length} parse error(s)`);
  return cfg;
}

const failed = results.filter((r) => r === 'FAIL').length;
const warned = results.filter((r) => r === 'WARN').length;
console.log(`\n${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
