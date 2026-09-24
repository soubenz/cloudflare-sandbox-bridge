import type { Family } from '../env';
import type { LabManifest } from '../labs/manifest';
import { renderManifest } from '../labs/manifest';
import type { SessionRuntime, SessionMeta, SnapshotEntry } from './state';
import { emitEvent, hasActiveEventClients } from './events';
import { BASE_ALLOWED_HOSTS } from '../families/egress';
import { scheduleTimer, cancelTimer, popDueTimers, rearmAlarm } from './timers';
import { hydrateWorkspaceFiles, hydratePressureScripts, applySessionEnv } from './hydrate';
import { startAllServices, relaunchAllServices, healthCheckAll, allServicesGone } from './services';
import { firePressureEvent } from './pressure';
import { tickMetrics } from './metrics';
import { resetTerminal } from './terminal';
import { updateSession, insertSnapshot, bestEffort } from './d1';
import { mintSessionToken, mintLlmToken } from '../auth';
import { ApiError } from '../lib/errors';
import { poolStub } from '../do/pool';

const IDLE_WARN_BEFORE_MS = 2 * 60_000;
const HARD_WARN_BEFORE_MS = 5 * 60_000;
const HEALTH_INTERVAL_ACTIVE_MS = 15_000;
const HEALTH_INTERVAL_IDLE_MS = 60_000;
const METRICS_INTERVAL_MS = 30_000;
const CLEANUP_AFTER_MS = 60 * 60_000;

export interface CreateSessionInput {
  userId: string;
  labSlug: string;
  labVersion: string;
  family: Family;
  manifest: LabManifest;
}

/**
 * `POST /sessions` RPC entry point. Stores meta + the raw manifest and
 * schedules the `start` timer for "now" — the actual container claim and
 * boot sequence (`runStart` below) happens when that timer fires, which is
 * a separate DO invocation from this one. That split is what makes a start
 * durable across a DO eviction: if the process restarts mid-boot, the
 * alarm is still owed and the platform redelivers it.
 */
export async function createSession(rt: SessionRuntime, input: CreateSessionInput): Promise<{ meta: SessionMeta; token: string }> {
  const now = Date.now();
  const meta: SessionMeta = {
    id: rt.sessionId,
    user_id: input.userId,
    lab_slug: input.labSlug,
    lab_version: input.labVersion,
    family: input.family,
    state: 'starting',
    created_at: now,
    resumed_count: 0,
  };
  await rt.putMeta(meta);
  await rt.putManifest(input.manifest);
  await scheduleTimer(rt, 'start', now);
  emitEvent(rt, 'session.state', { state: 'starting' });
  // No D1 insert here: the router already inserted this row (with the same
  // id) before calling create() — that INSERT is what enforces the
  // one-active-session-per-user unique index. From here on we only UPDATE.

  const token = await mintSessionToken(rt.env, { sid: meta.id, uid: meta.user_id, exp: Math.floor(now / 1000) + 3600 });
  return { meta, token };
}

/** The container start sequence (plan section 5), run from the `start` timer. */
async function runStart(rt: SessionRuntime): Promise<void> {
  const meta = await rt.requireMeta();
  const rawManifest = await rt.requireManifest();

  const claim = await poolStub(rt.env, meta.family).claim(rt.sessionId);
  await rt.patchMeta({ sandbox_id: claim.sandbox_id });
  await rt.bindBackend(meta.family, claim.sandbox_id);
  await rt.backend().ensureRunning();

  const baseUrl = rt.env.PUBLIC_BASE_URL;
  const manifest = renderManifest(rawManifest, rt.sessionId, baseUrl, rt.env.LLM_HOST);
  await rt.putManifest(manifest);

  await hydrateWorkspaceFiles(rt, meta.lab_slug, meta.lab_version);
  await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
  await applyEgressAllowlist(rt, manifest);

  const llmToken = await mintLlmToken(rt.env, rt.sessionId);
  await applySessionEnv(rt, {
    OPALIX_SESSION_ID: rt.sessionId,
    OPALIX_SESSION_TOKEN: llmToken,
    OPALIX_BASE_URL: baseUrl,
    LLM_BASE_URL: `http://${rt.env.LLM_HOST}`,
    ...manifest.env,
  });

  await startAllServices(rt, manifest);

  const now = Date.now();
  const expiresAt = now + manifest.timeout_minutes * 60_000;
  await rt.patchMeta({ state: 'running', started_at: now, expires_at: expiresAt });

  await scheduleTimer(rt, 'hard', expiresAt);
  await scheduleTimer(rt, 'hard_warn', expiresAt - HARD_WARN_BEFORE_MS);
  await scheduleIdleTimers(rt, now, manifest.idle_minutes);
  for (const event of manifest.pressure) {
    await scheduleTimer(rt, 'pressure', now + event.at_minutes * 60_000, event.id);
  }
  await scheduleTimer(rt, 'health', now + HEALTH_INTERVAL_IDLE_MS);
  await scheduleTimer(rt, 'metrics', now + METRICS_INTERVAL_MS);

  const finalMeta = await rt.requireMeta();
  bestEffort(updateSession(rt.env, finalMeta), 'updateSession(running)');
  emitEvent(rt, 'session.state', { state: 'running' });
}

async function scheduleIdleTimers(rt: SessionRuntime, from: number, idleMinutes: number): Promise<void> {
  const idleMs = idleMinutes * 60_000;
  await scheduleTimer(rt, 'idle', from + idleMs);
  await scheduleTimer(rt, 'idle_warn', from + idleMs - IDLE_WARN_BEFORE_MS);
}

/** Dispatched from the Session DO's `alarm()`. Runs every due timer, one kind at a time. */
export async function handleAlarm(rt: SessionRuntime): Promise<void> {
  const due = await popDueTimers(rt, Date.now());
  for (const timer of due) {
    try {
      // More than one timer can come due in the same tick, and one of them
      // may end the session (idle or hard expiry destroys the container).
      // Anything still queued behind it would then run against a container
      // that no longer exists, so stop as soon as the session is over.
      // `resume` and `cleanup` are the two that are meant to run on an
      // ended session.
      if (timer.kind !== 'cleanup' && timer.kind !== 'resume' && (await rt.requireMeta()).state === 'ended') {
        continue;
      }

      switch (timer.kind) {
        case 'start':
          await runStart(rt);
          break;
        case 'hard_warn':
          emitEvent(rt, 'session.expiring', { reason: 'hard_timeout' });
          break;
        case 'hard':
          await endSession(rt, 'expired');
          break;
        case 'idle_warn': {
          const meta = await rt.requireMeta();
          const idleFor = Date.now() - (meta.last_input_at ?? meta.started_at ?? Date.now());
          if (idleFor >= 0) emitEvent(rt, 'session.idle_warning', { idle_ms: idleFor });
          break;
        }
        case 'idle': {
          const meta = await rt.requireMeta();
          const manifest = await rt.requireManifest();
          const lastInput = meta.last_input_at ?? meta.started_at ?? 0;
          const idleMs = Date.now() - lastInput;
          if (idleMs >= manifest.idle_minutes * 60_000) {
            await endSession(rt, 'idle');
          } else {
            await scheduleIdleTimers(rt, lastInput, manifest.idle_minutes);
          }
          break;
        }
        case 'pressure': {
          const manifest = await rt.requireManifest();
          const event = manifest.pressure.find((e) => e.id === timer.ref);
          if (event) await firePressureEvent(rt, event);
          break;
        }
        case 'health':
          await runHealthTick(rt);
          break;
        case 'metrics': {
          const meta = await rt.requireMeta();
          if (meta.state === 'running') {
            await tickMetrics(rt);
            await scheduleTimer(rt, 'metrics', Date.now() + METRICS_INTERVAL_MS);
          }
          break;
        }
        case 'cleanup':
          await runCleanup(rt);
          break;
        case 'resume':
          await runResume(rt);
          break;
      }
    } catch (err) {
      emitEvent(rt, 'alert', { kind: 'timer_failed', timer: timer.kind, ref: timer.ref, error: String(err) });
      if (timer.kind === 'start' || timer.kind === 'resume') {
        await endSession(rt, 'error').catch(() => {});
      }
    }
  }
  await rearmAlarm(rt);
}

async function runHealthTick(rt: SessionRuntime): Promise<void> {
  const meta = await rt.requireMeta();
  if (meta.state !== 'running') return;

  if (await allServicesGone(rt)) {
    await recover(rt, 'all_services_gone');
  } else {
    await healthCheckAll(rt);
  }

  const interval = hasActiveEventClients(rt) ? HEALTH_INTERVAL_ACTIVE_MS : HEALTH_INTERVAL_IDLE_MS;
  await scheduleTimer(rt, 'health', Date.now() + interval);
}

/**
 * Container-restart recovery (plan section 3): confirm the container is
 * back, restore state (snapshot if we have one, else re-hydrate), relaunch
 * every service, and drop the stale terminal so the next attach reconnects
 * cleanly. Triggered by the health alarm noticing every service process
 * gone, or by a `Stale*HandleError` surfacing from any backend call.
 */
export async function recover(rt: SessionRuntime, reason: string): Promise<void> {
  const meta = await rt.requireMeta();
  if (meta.state === 'recovering') return;
  await rt.patchMeta({ state: 'recovering' });
  emitEvent(rt, 'container.restarted', { reason });

  await rt.backend().ensureRunning();

  const snapshots = await rt.snapshots();
  const manifest = await rt.requireManifest();
  if (snapshots[0]) {
    await rt.backend().restoreBackup({ id: snapshots[0].backup_id, dir: snapshots[0].dir });
    await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
  } else {
    emitEvent(rt, 'alert', { kind: 'recover_no_snapshot', message: 'No snapshot to restore; progress since session start was lost.' });
    await hydrateWorkspaceFiles(rt, meta.lab_slug, meta.lab_version);
    await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
  }

  const llmToken = await mintLlmToken(rt.env, rt.sessionId);
  await applySessionEnv(rt, {
    OPALIX_SESSION_ID: rt.sessionId,
    OPALIX_SESSION_TOKEN: llmToken,
    OPALIX_BASE_URL: rt.env.PUBLIC_BASE_URL,
    LLM_BASE_URL: `http://${rt.env.LLM_HOST}`,
    ...manifest.env,
  });

  await applyEgressAllowlist(rt, manifest);
  await relaunchAllServices(rt);
  await resetTerminal(rt);

  await rt.patchMeta({ state: 'running' });
  emitEvent(rt, 'session.state', { state: 'running', recovered: true });
}

/** `POST /sessions/{id}/snapshot` and the automatic snapshot taken on expiry/idle/user end. */
export async function snapshotNow(rt: SessionRuntime, reason: SnapshotEntry['reason']): Promise<SnapshotEntry> {
  const meta = await rt.requireMeta();
  const backup = await rt.backend().createBackup({
    dir: '/workspace',
    ttl: 7 * 24 * 3600,
    name: `${rt.sessionId}-${Date.now()}`,
    excludes: ['**/.venv', '**/node_modules', '**/__pycache__'],
    gitignore: true,
  });
  const entry: SnapshotEntry = { backup_id: backup.id, dir: backup.dir, ttl: 7 * 24 * 3600, created_at: Date.now(), reason };
  const snapshots = await rt.snapshots();
  await rt.putSnapshots([entry, ...snapshots]);
  emitEvent(rt, 'snapshot.created', entry);
  bestEffort(insertSnapshot(rt.env, rt.sessionId, meta.user_id, meta.lab_slug, entry), 'insertSnapshot');
  return entry;
}

/** `POST /sessions/{id}/resume`. Schedules a `resume` timer for the same durability reason `createSession` schedules `start`. */
export async function requestResume(rt: SessionRuntime): Promise<{ meta: SessionMeta; token: string }> {
  const meta = await rt.requireMeta();
  if (meta.state !== 'ended') throw ApiError.conflict('cannot_resume', `Session is ${meta.state}, not ended`);
  const snapshots = await rt.snapshots();
  if (snapshots.length === 0) throw ApiError.conflict('no_snapshot', 'No snapshot to resume from');

  const next = await rt.patchMeta({ state: 'resuming' });
  await scheduleTimer(rt, 'resume', Date.now());
  emitEvent(rt, 'session.state', { state: 'resuming' });

  const token = await mintSessionToken(rt.env, { sid: rt.sessionId, uid: meta.user_id, exp: Math.floor(Date.now() / 1000) + 3600 });
  return { meta: next, token };
}

async function runResume(rt: SessionRuntime): Promise<void> {
  const meta = await rt.requireMeta();
  const manifest = await rt.requireManifest();
  const snapshots = await rt.snapshots();
  const latest = snapshots[0];
  if (!latest) throw new Error('resume fired with no snapshot');

  const claim = await poolStub(rt.env, meta.family).claim(rt.sessionId);
  await rt.patchMeta({ sandbox_id: claim.sandbox_id });
  await rt.bindBackend(meta.family, claim.sandbox_id);
  await rt.backend().ensureRunning();

  await rt.backend().restoreBackup({ id: latest.backup_id, dir: latest.dir });
  await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);

  const llmToken = await mintLlmToken(rt.env, rt.sessionId);
  await applySessionEnv(rt, {
    OPALIX_SESSION_ID: rt.sessionId,
    OPALIX_SESSION_TOKEN: llmToken,
    OPALIX_BASE_URL: rt.env.PUBLIC_BASE_URL,
    LLM_BASE_URL: `http://${rt.env.LLM_HOST}`,
    ...manifest.env,
  });
  await applyEgressAllowlist(rt, manifest);
  await startAllServices(rt, manifest);
  await rt.putTerminal(undefined);

  const now = Date.now();
  const expiresAt = now + manifest.timeout_minutes * 60_000;
  const next = await rt.patchMeta({
    state: 'running',
    started_at: now,
    expires_at: expiresAt,
    last_input_at: now,
    resumed_count: meta.resumed_count + 1,
    ended_at: undefined,
    end_reason: undefined,
  });

  await scheduleTimer(rt, 'hard', expiresAt);
  await scheduleTimer(rt, 'hard_warn', expiresAt - HARD_WARN_BEFORE_MS);
  await scheduleIdleTimers(rt, now, manifest.idle_minutes);
  for (const event of manifest.pressure) {
    await scheduleTimer(rt, 'pressure', now + event.at_minutes * 60_000, event.id);
  }
  await scheduleTimer(rt, 'health', now + HEALTH_INTERVAL_IDLE_MS);
  await scheduleTimer(rt, 'metrics', now + METRICS_INTERVAL_MS);

  bestEffort(updateSession(rt.env, next), 'updateSession(resumed)');
  emitEvent(rt, 'session.state', { state: 'running', resumed: true });
}

/** `DELETE /sessions/{id}` and every automatic end path (idle/expired/error). */
export async function endSession(rt: SessionRuntime, reason: SnapshotEntry['reason'] | 'user', snapshot = true): Promise<void> {
  const meta = await rt.requireMeta();
  if (meta.state === 'ended') return; // idempotent

  if (snapshot && meta.sandbox_id && (meta.state === 'running' || meta.state === 'recovering')) {
    await snapshotNow(rt, reason === 'user' ? 'user' : reason).catch((err) =>
      emitEvent(rt, 'alert', { kind: 'snapshot_on_end_failed', error: String(err) })
    );
  }

  if (meta.sandbox_id) {
    await rt.backend().destroy().catch(() => {});
    await poolStub(rt.env, meta.family).release(meta.sandbox_id).catch(() => {});
  }
  rt.upstreamTerminalSocket?.close();
  rt.upstreamTerminalSocket = undefined;
  rt.upstreamTerminalHandle = undefined;

  const now = Date.now();
  const next = await rt.patchMeta({ state: 'ended', ended_at: now, end_reason: reason === 'user' ? 'user' : reason });

  for (const kind of ['hard', 'hard_warn', 'idle', 'idle_warn', 'health', 'metrics'] as const) {
    await cancelTimer(rt, kind);
  }
  await scheduleTimer(rt, 'cleanup', now + CLEANUP_AFTER_MS);

  bestEffort(updateSession(rt.env, next), 'updateSession(ended)');
  emitEvent(rt, 'session.state', { state: 'ended', reason });
}

/** Drops the SQL event log and most storage keys an hour after end, keeping only what a resume or history view needs. */
async function runCleanup(rt: SessionRuntime): Promise<void> {
  rt.sql.exec('DELETE FROM events');
  await rt.putServices({});
  await rt.putTerminal(undefined);
  await rt.putPressureStatus({});
}

/**
 * Per-lab egress hosts are a union with the family's base list, never a
 * replacement — see families/egress.ts. Re-applied on resume and recover
 * because both run on a freshly claimed sandbox that carries none of the
 * previous container's runtime overrides.
 */
async function applyEgressAllowlist(rt: SessionRuntime, manifest: LabManifest): Promise<void> {
  // Nothing to add means the container's static allowlist is already
  // right; skip it rather than spend a retrying container call (which can
  // block a start for tens of seconds) to set the value it already has.
  if (manifest.egress.allow.length === 0) return;
  const hosts = [...new Set([...BASE_ALLOWED_HOSTS, ...manifest.egress.allow])];
  await rt
    .backend()
    .setAllowedHosts(hosts)
    .catch((err) => emitEvent(rt, 'alert', { kind: 'set_allowed_hosts_failed', error: String(err) }));
}
