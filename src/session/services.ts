import type { LabManifest, ServiceSpec } from '../labs/manifest';
import type { SessionRuntime, ServiceRuntime, ServiceHealth } from './state';
import { emitEvent } from './events';
import { ApiError } from '../lib/errors';
import type { SandboxProcess } from '@cloudflare/sandbox';

const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/** Kahn's algorithm over `depends_on`. manifest.ts already validated every dependency name resolves. */
export function topoOrder(services: ServiceSpec[]): ServiceSpec[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  // Deduplicated: a repeated dependency would raise indegree twice but only
  // ever be decremented once, reporting a dependency cycle that isn't there.
  const deps = new Map(services.map((s) => [s.name, [...new Set(s.depends_on)]]));
  const indegree = new Map(services.map((s) => [s.name, deps.get(s.name)!.length]));

  const ready = services.filter((s) => (indegree.get(s.name) ?? 0) === 0).map((s) => s.name);
  const order: ServiceSpec[] = [];
  const remaining = new Set(services.map((s) => s.name));

  while (ready.length > 0) {
    const name = ready.shift()!;
    remaining.delete(name);
    const spec = byName.get(name)!;
    order.push(spec);
    for (const s of services) {
      if (deps.get(s.name)!.includes(name)) {
        const next = (indegree.get(s.name) ?? 0) - 1;
        indegree.set(s.name, next);
        if (next === 0 && remaining.has(s.name)) ready.push(s.name);
      }
    }
  }
  if (order.length !== services.length) throw new Error('service dependency cycle detected');
  return order;
}

/**
 * Starts one service and records its runtime state, but does not throw on a
 * health-check timeout — a lab with one flaky service should still be
 * enterable; status/events show the failure instead. Used by both the
 * initial start sequence and by `relaunchAllServices` after a container
 * restart.
 */
export async function startService(rt: SessionRuntime, spec: ServiceSpec): Promise<ServiceRuntime> {
  const backend = rt.backend();
  const proc = await backend.exec(spec.argv, { cwd: spec.cwd, env: spec.env });
  const runtime: ServiceRuntime = {
    spec,
    process_id: proc.id,
    pid: proc.pid,
    started_at: Date.now(),
    restarts: 0,
    health: 'unknown',
  };

  if (spec.port !== undefined) {
    try {
      await proc.waitForPort(spec.port, {
        mode: spec.healthcheck?.type ?? 'tcp',
        path: spec.healthcheck?.path,
        timeout: (spec.healthcheck?.timeout_s ?? 30) * 1000,
      });
      runtime.health = 'healthy';
      runtime.last_health_at = Date.now();
    } catch (err) {
      runtime.health = 'unhealthy';
      runtime.last_health_at = Date.now();
      const logsTail = await tailLogs(proc);
      emitEvent(rt, 'service.health', { service: spec.name, health: 'unhealthy', reason: String(err), logs_tail: logsTail });
    }
  }
  return runtime;
}

async function tailLogs(proc: { logs: (opts: { replay: boolean }) => Promise<ReadableStream> }): Promise<string> {
  try {
    const stream = await proc.logs({ replay: true });
    const reader = stream.getReader();
    const chunks: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await reader.cancel().catch(() => {});
    return JSON.stringify(chunks).slice(-1024);
  } catch {
    return '';
  }
}

/** Starts every service in dependency order, persisting runtime state as it goes. Called once from lifecycle.start. */
export async function startAllServices(rt: SessionRuntime, manifest: LabManifest): Promise<void> {
  const services = await rt.services();
  for (const spec of topoOrder(manifest.services)) {
    const runtime = await startService(rt, spec);
    services[spec.name] = runtime;
    await rt.putServices(services);
    emitEvent(rt, 'service.health', { service: spec.name, health: runtime.health });
  }
}

/** Kills (SIGTERM, then SIGKILL after 5s) and restarts a single named service. */
export async function restartService(rt: SessionRuntime, name: string): Promise<ServiceRuntime> {
  const services = await rt.services();
  const existing = services[name];
  if (!existing) throw ApiError.notFound('unknown_service', `unknown service "${name}"`);
  const backend = rt.backend();

  if (existing.process_id) {
    const proc = await backend.getProcess(existing.process_id);
    if (proc) {
      await proc.kill(15);
      const exited = await Promise.race([
        proc.waitForExit({ timeout: 5000 }).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (!exited) await proc.kill(9).catch(() => {});
    }
  }

  const runtime = await startService(rt, existing.spec);
  runtime.restarts = existing.restarts + 1;
  services[name] = runtime;
  await rt.putServices(services);
  await rt.touchInput();
  emitEvent(rt, 'service.health', { service: name, health: runtime.health, restarted: true });
  return runtime;
}

/** Re-launches every service from its stored spec after a container restart. Process/pid ids from the old container are stale by definition. */
export async function relaunchAllServices(rt: SessionRuntime): Promise<void> {
  const services = await rt.services();
  for (const [name, existing] of Object.entries(services)) {
    const runtime = await startService(rt, existing.spec);
    runtime.restarts = existing.restarts;
    services[name] = runtime;
    await rt.putServices(services);
    emitEvent(rt, 'service.health', { service: name, health: runtime.health, relaunched: true });
  }
}

/**
 * Polled by the health alarm. Re-runs each service's declared healthcheck
 * against its port, rather than only asking whether the process still
 * exists: a service that binds its port and then wedges — accepting TCP
 * but failing its HTTP healthcheck — keeps a live pid, and would
 * otherwise read `healthy` for the whole session while the learner sees a
 * broken system. Detecting a container restart (all pids gone) is
 * lifecycle.recover's job, not this function's.
 */
export async function healthCheckAll(rt: SessionRuntime): Promise<void> {
  const services = await rt.services();
  const backend = rt.backend();
  for (const [name, runtime] of Object.entries(services)) {
    if (!runtime.process_id) continue;
    const proc = await backend.getProcess(runtime.process_id);
    const health: ServiceHealth = proc ? await probeService(proc, runtime) : 'unhealthy';
    if (health !== runtime.health) {
      services[name] = { ...runtime, health, last_health_at: Date.now() };
      emitEvent(rt, 'service.health', { service: name, health });
    }
  }
  await rt.putServices(services);
}

/** A short probe: this runs on every health tick, so it must not stall the alarm. */
async function probeService(proc: SandboxProcess, runtime: ServiceRuntime): Promise<ServiceHealth> {
  const { port, healthcheck } = runtime.spec;
  if (port === undefined) return runtime.health;
  try {
    await proc.waitForPort(port, {
      mode: healthcheck?.type ?? 'tcp',
      path: healthcheck?.path,
      timeout: HEALTH_PROBE_TIMEOUT_MS,
    });
    return 'healthy';
  } catch {
    return 'unhealthy';
  }
}

/** True if every service process the Session DO started is gone — the health alarm's signal to call lifecycle.recover. */
export async function allServicesGone(rt: SessionRuntime): Promise<boolean> {
  const services = await rt.services();
  const names = Object.keys(services);
  if (names.length === 0) return false;
  const backend = rt.backend();
  for (const runtime of Object.values(services)) {
    if (!runtime.process_id) continue;
    const proc = await backend.getProcess(runtime.process_id);
    if (proc) return false;
  }
  return true;
}
