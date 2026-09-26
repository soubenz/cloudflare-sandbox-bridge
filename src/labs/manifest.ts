import { z } from 'zod';

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * A service port has to satisfy the sandbox SDK's own rule, not just the
 * 1-65535 of TCP. `validatePort` in
 * node_modules/@cloudflare/sandbox/dist/sandbox-cmlgGVYX.js documents it as:
 *
 *   - Range: 1024-65535 (privileged ports require root, which containers don't have)
 *   - Reserved: 3000 (sandbox control plane)
 *
 * The SDK's stated reason for the lower bound does not match what the
 * container actually is: lab sessions run as root — hydrate chowns
 * /workspace and the terminal does `su -l learner`, both of which need it.
 * The likeliest reconciliation is a missing CAP_NET_BIND_SERVICE rather
 * than a non-root uid, but we have not proven that, so the error message
 * states the rule and not a cause we would be guessing at.
 *
 * and every SDK entry point that takes a port (connect(), containerFetch(),
 * constructPreviewURL(), the tunnel service) throws SandboxSecurityError
 * "Invalid port number: N. Must be 1024-65535, excluding 3000 (sandbox
 * control plane)." when it fails. Validating the wider range here only moved
 * the failure from publish time to session start, where it is far more
 * expensive to diagnose: port 3000 in particular does not even fail as a
 * rejected port, the service binds against the control plane and dies with
 * "address already in use", which reads as a crashing service rather than
 * an invalid manifest.
 */
export const MIN_SERVICE_PORT = 1024;
export const MAX_SERVICE_PORT = 65535;
export const SANDBOX_CONTROL_PLANE_PORT = 3000;

const servicePortSchema = z
  .number()
  .int()
  .superRefine((port, ctx) => {
    if (port === SANDBOX_CONTROL_PLANE_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `port ${SANDBOX_CONTROL_PLANE_PORT} is reserved for the sandbox control plane; pick another port in ${MIN_SERVICE_PORT}-${MAX_SERVICE_PORT}`,
      });
      return;
    }
    if (port < MIN_SERVICE_PORT || port > MAX_SERVICE_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `port must be ${MIN_SERVICE_PORT}-${MAX_SERVICE_PORT}: the sandbox runtime refuses to route a privileged port`,
      });
    }
  });

const healthcheckSchema = z.object({
  type: z.enum(['http', 'tcp']).default('tcp'),
  path: z.string().default('/'),
  timeout_s: z.number().int().positive().max(120).default(30),
});

const serviceSchema = z.object({
  name: z.string().min(1).max(40),
  argv: z.array(z.string()).min(1),
  cwd: z.string().default('/workspace'),
  // Shell identifiers only: the session env is written to a file that
  // every login shell sources, so `MY-KEY` would break shell startup and a
  // key containing a backtick or $( ) would execute.
  env: z.record(z.string()).default({}).refine(
    (env) => Object.keys(env).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)),
    { message: 'env keys must be shell identifiers: letters, digits and underscore, not starting with a digit' }
  ),
  port: servicePortSchema.optional(),
  healthcheck: healthcheckSchema.optional(),
  /** Whether this service has a browsable UI to proxy at /sessions/{id}/services/{name}/. */
  ui: z.boolean().default(false),
  depends_on: z.array(z.string()).default([]),
});

const pressureEventSchema = z.object({
  id: z.string().min(1).max(40),
  at_minutes: z.number().int().nonnegative(),
  argv: z.array(z.string()).min(1),
  title: z.string().min(1),
  message: z.string().min(1),
});

const checkSchema = z.object({
  name: z.string().min(1).max(80),
  script: z.string().min(1), // path relative to checks/ inside private.tgz
  timeout_s: z.number().int().positive().max(300).default(30),
  weight: z.number().positive().default(1),
  parallel: z.boolean().default(false),
});

const hintSchema = z.object({
  after_minutes: z.number().int().nonnegative(),
  text: z.string().min(1),
});

const egressSchema = z.object({
  allow: z.array(z.string()).default([]),
});

export const labManifestSchema = z.object({
  slug: z.string().regex(slugPattern, 'slug must be lowercase, hyphenated, 3-64 chars'),
  version: z.string().regex(versionPattern, 'version must be semver, e.g. 1.0.0'),
  title: z.string().min(1).max(200),
  type: z.enum(['build', 'break-fix', 'scale', 'explore']),
  family: z.enum(['agent', 'gateway']),
  /**
   * One sentence for the launcher card: what this lab is about, before a
   * learner has spent a container finding out. The title alone cannot
   * carry it — "Hello, sandbox" says nothing about what you would do.
   */
  summary: z.string().min(1).max(280).optional(),
  /**
   * What a learner should be able to do afterwards. Shown at the top of the
   * brief, so the point of the exercise is stated rather than left to be
   * inferred from the task. Kept in the manifest rather than in brief.md
   * because the catalogue shows them before a session exists.
   */
  objectives: z.array(z.string().min(1).max(200)).max(6).default([]),
  /** Rough level, for sorting and for setting expectations on the card. */
  difficulty: z.enum(['intro', 'core', 'advanced']).optional(),
  timeout_minutes: z.number().int().min(60).max(120),
  idle_minutes: z.number().int().min(1).max(60).default(10),
  // Shell identifiers only: the session env is written to a file that
  // every login shell sources, so `MY-KEY` would break shell startup and a
  // key containing a backtick or $( ) would execute.
  env: z.record(z.string()).default({}).refine(
    (env) => Object.keys(env).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)),
    { message: 'env keys must be shell identifiers: letters, digits and underscore, not starting with a digit' }
  ),
  services: z.array(serviceSchema).min(1),
  pressure: z.array(pressureEventSchema).default([]),
  checks: z.array(checkSchema).min(1),
  hints: z.array(hintSchema).default([]),
  egress: egressSchema.default({ allow: [] }),
});

export type LabManifest = z.infer<typeof labManifestSchema>;
export type ServiceSpec = z.infer<typeof serviceSchema>;
export type PressureEvent = z.infer<typeof pressureEventSchema>;
export type CheckSpec = z.infer<typeof checkSchema>;

export function parseManifest(json: unknown): LabManifest {
  const result = labManifestSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid lab manifest: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const manifest = result.data;
  // Every services[].depends_on must name a service declared in this same
  // manifest — catches typos at publish time instead of at session start
  // inside a container. checks[].script is deliberately NOT validated here:
  // it is a path relative to checks/ inside the lab's private tarball,
  // which this schema never sees, so whether it exists can only be found
  // out when the checks run in the container.
  const serviceNames = new Set(manifest.services.map((s) => s.name));
  const portOwners = new Map<number, string>();
  for (const svc of manifest.services) {
    for (const dep of svc.depends_on) {
      if (!serviceNames.has(dep)) {
        throw new Error(`service "${svc.name}" depends_on unknown service "${dep}"`);
      }
    }
    // Two services on one port is the same class of mistake as a reserved
    // port: the second one binds, dies with "address already in use", and
    // reads as a crashing service rather than as a manifest that asked for
    // the impossible.
    if (svc.port !== undefined) {
      const owner = portOwners.get(svc.port);
      if (owner !== undefined) {
        throw new Error(`services "${owner}" and "${svc.name}" both declare port ${svc.port}`);
      }
      portOwners.set(svc.port, svc.name);
    }
    // `ui: true` promises a browsable surface at
    // /sessions/{id}/services/{name}/, and the proxy has nowhere to send a
    // request without a port — it answers 400 at request time. Say so at
    // publish time, where the author can still fix it.
    if (svc.ui && svc.port === undefined) {
      throw new Error(`service "${svc.name}" is marked ui: true but declares no port to proxy`);
    }
  }
  return manifest;
}

export interface TemplateContext {
  session: { id: string; base_url: string };
  service: { prefix: string };
  llm: { host: string };
}

/** Substitutes `{{session.id}}`, `{{service.prefix}}`, `{{llm.host}}` etc. in a single string. */
export function renderTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in acc) return (acc as Record<string, unknown>)[key];
      return undefined;
    }, ctx);
    if (value === undefined) throw new Error(`Unknown template variable {{${path}}}`);
    return String(value);
  });
}

function serviceCtx(sessionId: string, baseUrl: string, serviceName: string): TemplateContext {
  return {
    session: { id: sessionId, base_url: baseUrl },
    service: { prefix: `/sessions/${sessionId}/services/${serviceName}` },
    llm: { host: '' }, // filled in by renderManifest below with the real llm host
  };
}

/**
 * Renders every templated string in a manifest for one concrete session,
 * producing the normalised manifest stored in the Session DO's `manifest`
 * key. Called once at session start (lifecycle.start); the result is what
 * services.ts and pressure.ts read from, never the raw manifest again.
 */
export function renderManifest(manifest: LabManifest, sessionId: string, baseUrl: string, llmHost: string): LabManifest {
  const renderStr = (s: string, serviceName: string) =>
    renderTemplate(s, { ...serviceCtx(sessionId, baseUrl, serviceName), llm: { host: llmHost } });

  return {
    ...manifest,
    env: mapValues(manifest.env, (v) => renderStr(v, '')),
    services: manifest.services.map((svc) => ({
      ...svc,
      argv: svc.argv.map((a) => renderStr(a, svc.name)),
      cwd: renderStr(svc.cwd, svc.name),
      env: mapValues(svc.env, (v) => renderStr(v, svc.name)),
      healthcheck: svc.healthcheck
        ? { ...svc.healthcheck, path: svc.healthcheck.path ? renderStr(svc.healthcheck.path, svc.name) : svc.healthcheck.path }
        : svc.healthcheck,
    })),
    pressure: manifest.pressure.map((p) => ({
      ...p,
      argv: p.argv.map((a) => renderStr(a, '')),
      title: renderStr(p.title, ''),
      message: renderStr(p.message, ''),
    })),
    hints: manifest.hints.map((h) => ({ ...h, text: renderStr(h.text, '') })),
    egress: { ...manifest.egress, allow: manifest.egress.allow.map((h) => renderStr(h, '')) },
  };
}

function mapValues<T extends Record<string, string>>(obj: T, fn: (v: string) => string): T {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out as T;
}
