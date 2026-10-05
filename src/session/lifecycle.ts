import type { Env, Family } from '../env';
import type { LabManifest } from '../labs/manifest';
import { renderManifest } from '../labs/manifest';
import type { SessionRuntime, SessionMeta, SnapshotEntry, TimerKind, TimerEntry } from './state';
import { isStuck } from './state';
import { emitEvent, hasActiveEventClients } from './events';
import { BASE_ALLOWED_HOSTS } from '../families/egress';
import { scheduleTimer, cancelTimer, cancelTimersOfKind, cancelTimersExcept, popDueTimers, rearmAlarm } from './timers';
import { hydrateWorkspaceFiles, hydratePressureScripts, applySessionEnv } from './hydrate';
import { startAllServices, relaunchAllServices, healthCheckAll, allServicesGone } from './services';
import { firePressureEvent } from './pressure';
import { tickMetrics } from './metrics';
import { tryEmitSolutionUnlocked } from './solution';
import { resetTerminal } from './terminal';
import { updateSession, insertSnapshot, bestEffort, sessionRowState, activeSessionRows } from './d1';
import type { SessionCostRow } from './d1';
import { mintSessionToken, mintLlmToken, sessionTokenExp } from '../auth';
import { ApiError } from '../lib/errors';

/**
 * Imported lazily for the same reason state.ts defers backend.ts: do/pool.ts
 * extends `DurableObject` from the `cloudflare:workers` virtual module,
 * unresolvable under the plain-Node unit test pool (see vitest.config.ts).
 * Keeping it off the module's top level is what lets the unit suite load
 * lifecycle.ts at all; nothing it exercises claims a container.
 */
async function pool(rt: SessionRuntime, family: Family) {
  const { poolStub } = await import('../do/pool');
  return poolStub(rt.env, family);
}

const IDLE_WARN_BEFORE_MS = 5 * 60_000;
/** How long before the idle end the warning comes: five minutes, or half of a short idle limit. */
const idleWarnLeadMs = (idleMinutes: number) => Math.min(IDLE_WARN_BEFORE_MS, (idleMinutes * 60_000) / 2);
const HARD_WARN_BEFORE_MS = 5 * 60_000;
const HEALTH_INTERVAL_ACTIVE_MS = 15_000;
const HEALTH_INTERVAL_IDLE_MS = 60_000;
const METRICS_INTERVAL_MS = 30_000;
const CLEANUP_AFTER_MS = 60 * 60_000;
/**
 * How long a prepared (`ready`) session waits to be begun before it is ended
 * as `unclaimed`. It is the whole cost of an abandoned prefetch: one container
 * for about this long.
 */
export const PREPARE_TTL_MS = 10 * 60_000;
const PURGE_DEFAULT_AFTER_MS = 7 * 24 * 60 * 60_000;
/** A session stuck in `recovering` this long is dead; the health tick ends it. */
const RECOVERING_TIMEOUT_MS = 5 * 60_000;
/** Consecutive failed recoveries after which the health tick gives up and ends the session. */
const MAX_RECOVER_FAILURES = 3;
/**
 * A `start` or `resume` timer re-arms itself this far ahead before it runs the
 * boot, and the boot cancels it when it finishes. If the run is killed
 * mid-flight (a deploy, an eviction) the platform's alarm retry finds no
 * boot timer due; this watchdog is what runs the boot again. Every step of
 * runStart/runResume is safe to repeat (see their comments).
 */
export const BOOT_WATCHDOG_MS = 2 * 60_000;
/** Boot runs (the first plus watchdog retries) after which the session is ended as `error`. */
export const MAX_BOOT_ATTEMPTS = 3;

/**
 * Timers that re-arm themselves at the end of a successful run. handleAlarm
 * pops a timer before running it, so one throw would otherwise end the chain
 * for the rest of the session; the catch below re-arms these kinds.
 */
const RECURRING: Partial<Record<TimerKind, number>> = {
  health: HEALTH_INTERVAL_IDLE_MS,
  metrics: METRICS_INTERVAL_MS,
};

export interface CreateSessionInput {
  userId: string;
  labSlug: string;
  labVersion: string;
  family: Family;
  manifest: LabManifest;
  /** Pre-warm: boot the container but park in `ready` with no lab clocks until `begin`. */
  prepare?: boolean;
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
    ...(input.prepare ? { prepare: true } : {}),
  };
  await rt.putMeta(meta);
  await rt.putManifest(input.manifest);
  await scheduleTimer(rt, 'start', now);
  emitEvent(rt, 'session.state', { state: 'starting' });
  // No D1 insert here: the router already inserted this row (with the same
  // id) before calling create() — that INSERT is what enforces the
  // one-active-session-per-user unique index. From here on we only UPDATE.

  // The token has to outlive the session itself (there is no refresh
  // route), and `expires_at` does not exist yet — runStart sets it when the
  // session reaches `running`. Derive the same budget runStart will use
  // from the manifest, so a 120-minute lab gets a 120-minute token.
  const token = await mintSessionToken(rt.env, {
    sid: meta.id,
    uid: meta.user_id,
    exp: sessionTokenExp(now + input.manifest.timeout_minutes * 60_000),
  });
  return { meta, token };
}

/**
 * The container start sequence (plan section 5), run from the `start` timer.
 *
 * Retry-safe: handleAlarm re-runs it from the watchdog when a run was killed
 * mid-flight, so every step may find the previous attempt's work done. The
 * claim is reused (stored `sandbox_id`, and Pool.claim is idempotent per
 * session for the window before it is stored); `ensureRunning` is a no-op on a
 * running container; the manifest render has no templates left to replace the
 * second time; hydrate re-extracts the same bundles over a workspace no
 * learner has touched yet (`starting`); the env files are overwritten; and on
 * a retry `startAllServices` stops the processes the killed attempt launched
 * before launching them again, so no service runs twice.
 *
 * Cancel-safe: a DELETE or a pre-warm cancel can end the session while any
 * container call here is in flight. endSession destroys the container then,
 * but the call in flight (ensureRunning above all) can bring it back, so
 * after every container step the session is re-read and, once it has ended,
 * the container is destroyed again and its claim released before returning.
 */
async function runStart(rt: SessionRuntime, attempt = 1): Promise<void> {
  const meta = await rt.requireMeta();
  const rawManifest = await rt.requireManifest();

  // The `start` timer is deliberately retryable: if the DO is evicted
  // mid-start the alarm runs this again. Claiming unconditionally would
  // then take a second container and overwrite the id of the first, which
  // end() would never destroy — it would sit in the pool's `claimed` map
  // until the 3-hour reap. Reuse the claim we already hold.
  const sandboxId = meta.sandbox_id ?? (await (await pool(rt, meta.family)).claim(rt.sessionId)).sandbox_id;
  /** True (after destroying the container and giving back the claim) once the session has ended under us. */
  const abandoned = () => abandonIfEnded(rt, meta.family, sandboxId);
  // A DELETE (a prepared session cancelled while it boots) can end the session
  // while the claim was in flight. endSession saw no container to release, so
  // the one just claimed is ours to give back.
  if (await abandoned()) return;
  if (meta.sandbox_id !== sandboxId) await rt.patchMeta({ sandbox_id: sandboxId });
  await rt.bindBackend(meta.family, sandboxId);
  await rt.backend().ensureRunning();
  if (await abandoned()) return;

  const baseUrl = rt.env.PUBLIC_BASE_URL;
  const manifest = renderManifest(rawManifest, rt.sessionId, baseUrl, rt.env.LLM_HOST);
  await rt.putManifest(manifest);

  await hydrateWorkspaceFiles(rt, meta.lab_slug, meta.lab_version);
  if (await abandoned()) return;
  await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
  if (await abandoned()) return;
  await applyEgressAllowlist(rt, manifest);
  if (await abandoned()) return;

  const llmToken = await mintLlmToken(rt.env, rt.sessionId);
  await applySessionEnv(rt, {
    OPALIX_SESSION_ID: rt.sessionId,
    OPALIX_SESSION_TOKEN: llmToken,
    OPALIX_BASE_URL: baseUrl,
    LLM_BASE_URL: llmBaseUrl(rt.env),
    LLM_MODEL: rt.env.LLM_MODEL,
    ...manifest.env,
  });
  if (await abandoned()) return;

  await startAllServices(rt, manifest, { stopRecorded: attempt > 1 });

  // Decided now, not at the top: `begin` may have arrived while this ran, and
  // a prepared session that has been begun is simply a session that is starting.
  if (await abandoned()) return; // cancelled mid-boot
  const current = await rt.requireMeta();
  const now = Date.now();
  if (current.prepare) {
    // Pre-warm: everything is up, but the lab has not begun. No expiry, no
    // idle/hard/hint/pressure/health timers; one timer reclaims the container
    // if nobody ever begins it.
    const next = await rt.patchMeta({ state: 'ready', prepared_at: now, boot_attempts: undefined });
    await scheduleTimer(rt, 'prepare_expiry', now + PREPARE_TTL_MS);
    bestEffort(updateSession(rt.env, next), 'updateSession(ready)');
    emitEvent(rt, 'session.state', { state: 'ready' });
    return;
  }

  const expiresAt = now + manifest.timeout_minutes * 60_000;
  await rt.patchMeta({ state: 'running', started_at: now, expires_at: expiresAt, boot_attempts: undefined });
  await scheduleRunTimers(rt, manifest, now, expiresAt);

  const finalMeta = await rt.requireMeta();
  bestEffort(updateSession(rt.env, finalMeta), 'updateSession(running)');
  emitEvent(rt, 'session.state', { state: 'running' });
}

/**
 * The boot's cancel check: false while the session is live. Once it has ended
 * (a DELETE, a pre-warm cancel or the stuck-boot rule ran while a container
 * call was in flight), destroys `sandboxId` and releases its claim, then
 * returns true so the boot stops. Both repeat what endSession did if it saw
 * the id, and both are harmless to repeat; what they undo is a container the
 * in-flight call brought back after that end destroyed it. Only `ended`
 * counts: any other state is a live session and keeps its container.
 */
async function abandonIfEnded(rt: SessionRuntime, family: Family, sandboxId: string): Promise<boolean> {
  if ((await rt.requireMeta()).state !== 'ended') return false;
  await destroyQuietly(rt, family, sandboxId);
  return true;
}

/** Destroys a container and releases its pool claim, swallowing failures (a missing container is already destroyed). */
async function destroyQuietly(rt: SessionRuntime, family: Family, sandboxId: string): Promise<void> {
  try {
    await rt.bindBackend(family, sandboxId);
    await rt.backend().destroy();
  } catch {
    /* already gone, or unreachable: the pool's reaper is the backstop */
  }
  try {
    await (await pool(rt, family)).release(sandboxId);
  } catch {
    /* idem */
  }
}

/**
 * The timers of a running session: hard expiry and its warning, idle, pressure
 * events, hints, health and metrics. One list for a normal start, a resume and
 * `begin` of a prepared session, so the three can never drift apart.
 */
async function scheduleRunTimers(rt: SessionRuntime, manifest: LabManifest, now: number, expiresAt: number): Promise<void> {
  await scheduleTimer(rt, 'hard', expiresAt);
  await scheduleTimer(rt, 'hard_warn', expiresAt - HARD_WARN_BEFORE_MS);
  await scheduleIdleTimers(rt, now, manifest.idle_minutes);
  for (const event of manifest.pressure) {
    await scheduleTimer(rt, 'pressure', now + event.at_minutes * 60_000, event.id);
  }
  for (const [index, hint] of manifest.hints.entries()) {
    await scheduleTimer(rt, 'hint', now + hint.after_minutes * 60_000, String(index));
  }
  await scheduleTimer(rt, 'health', now + HEALTH_INTERVAL_IDLE_MS);
  await scheduleTimer(rt, 'metrics', now + METRICS_INTERVAL_MS);
}

/**
 * `POST /sessions/{id}/begin` (and the reuse path of `POST /sessions/start`):
 * the lab begins now. A `ready` session starts its clocks (`started_at`,
 * `expires_at`, every run timer) and drops the claim timer; one still booting
 * is told it is no longer a pre-warm, so its start sequence finishes straight
 * into `running`. Idempotent for anything already begun. An ended session
 * cannot begin: the caller starts a fresh one.
 */
export async function beginSession(rt: SessionRuntime): Promise<{ meta: SessionMeta; token: string }> {
  const meta = await rt.requireMeta();
  if (meta.state === 'ended') throw ApiError.conflict('cannot_begin', 'The session has ended');
  const manifest = await rt.requireManifest();

  let next = meta;
  if (meta.state === 'ready') {
    const now = Date.now();
    const expiresAt = now + manifest.timeout_minutes * 60_000;
    await cancelTimersOfKind(rt, 'prepare_expiry');
    next = await rt.patchMeta({ state: 'running', started_at: now, expires_at: expiresAt, prepare: undefined });
    // Compute billed to the lab starts here; the ready minutes are not the learner's.
    await rt.putCost({ ...(await rt.cost()), accounted_until: now });
    await scheduleRunTimers(rt, manifest, now, expiresAt);
    bestEffort(updateSession(rt.env, next), 'updateSession(begun)');
    emitEvent(rt, 'session.state', { state: 'running', began: true });
  } else if (meta.state === 'starting' && meta.prepare) {
    next = await rt.patchMeta({ prepare: undefined });
  }

  // The token must outlive the session: its real expiry once running, the
  // manifest's budget from now for one that is still booting.
  const expiresAt = next.expires_at ?? Date.now() + manifest.timeout_minutes * 60_000;
  const token = await mintSessionToken(rt.env, { sid: rt.sessionId, uid: next.user_id, exp: sessionTokenExp(expiresAt) });
  return { meta: next, token };
}

/**
 * Cancels a session only while it is still an unbegun pre-warm (`ready`, or
 * `starting` with `prepare` set). Returns whether it did. Conditional inside
 * the DO so a late cancel (a closing tab's beacon) can never end a lab the
 * learner has since begun.
 */
export async function cancelPrepared(rt: SessionRuntime): Promise<boolean> {
  const meta = await rt.meta();
  if (!meta) return false;
  const unbegun = meta.state === 'ready' || (meta.state === 'starting' && meta.prepare === true);
  if (!unbegun) return false;
  await endSession(rt, 'user', false);
  return true;
}

async function scheduleIdleTimers(rt: SessionRuntime, from: number, idleMinutes: number): Promise<void> {
  const idleMs = idleMinutes * 60_000;
  await scheduleTimer(rt, 'idle', from + idleMs);
  await scheduleTimer(rt, 'idle_warn', from + idleMs - idleWarnLeadMs(idleMinutes));
}

/** The state a boot timer's session must be in for that timer to run. */
const BOOT_STATE: Partial<Record<TimerKind, SessionMeta['state']>> = { start: 'starting', resume: 'resuming' };

/** Dispatched from the Session DO's `alarm()`. Runs every due timer, one kind at a time. */
export async function handleAlarm(rt: SessionRuntime): Promise<void> {
  const now = Date.now();
  const state = (await rt.meta())?.state;
  // A boot timer (`start`, `resume`) is replaced by its own watchdog in the
  // same write that pops it: if this run is killed mid-boot, the watchdog is
  // still owed and runs the boot again. A finished run cancels it.
  const watchdog = (t: TimerEntry): TimerEntry | undefined =>
    BOOT_STATE[t.kind] !== undefined && BOOT_STATE[t.kind] === state ? { kind: t.kind, at: now + BOOT_WATCHDOG_MS, ref: t.ref } : undefined;
  const due = await popDueTimers(rt, now, watchdog);
  for (const timer of due) {
    try {
      // More than one timer can come due in the same tick, and one of them
      // may end the session (idle or hard expiry destroys the container).
      // Anything still queued behind it would then run against a container
      // that no longer exists, so stop as soon as the session is over.
      // `resume`, `cleanup` and `purge` are the ones that are meant to run
      // on an ended session.
      if (timer.kind !== 'cleanup' && timer.kind !== 'purge' && timer.kind !== 'resume' && (await rt.requireMeta()).state === 'ended') {
        continue;
      }

      switch (timer.kind) {
        case 'start':
        case 'resume':
          await runBoot(rt, timer);
          break;
        case 'prepare_expiry': {
          // Nobody began the pre-warmed lab in time. Only a still-`ready`
          // session is reclaimed: a begun one has cancelled this timer, and
          // anything else is not ours to end.
          if ((await rt.requireMeta()).state === 'ready') await endSession(rt, 'unclaimed', false);
          break;
        }
        case 'hard_warn':
          emitEvent(rt, 'session.expiring', { reason: 'hard_timeout' });
          break;
        case 'hard':
          await endSession(rt, 'expired');
          break;
        case 'idle_warn': {
          // Mirrors the `idle` branch below: `touchInput()` only moves
          // `last_input_at`, so a timer armed at start is stale for any
          // session that has seen input since. Either the session really is
          // about to be idle-killed, or we re-arm for the time that would
          // now be true.
          const meta = await rt.requireMeta();
          const manifest = await rt.requireManifest();
          const lastInput = meta.last_input_at ?? meta.started_at ?? 0;
          const idleMs = Date.now() - lastInput;
          const warnAfterMs = manifest.idle_minutes * 60_000 - idleWarnLeadMs(manifest.idle_minutes);
          if (idleMs >= warnAfterMs) {
            emitEvent(rt, 'session.idle_warning', { idle_ms: idleMs, ends_in_ms: Math.max(0, manifest.idle_minutes * 60_000 - idleMs) });
          } else {
            await scheduleTimer(rt, 'idle_warn', lastInput + warnAfterMs);
          }
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
        case 'hint': {
          // Hints unlock on a timer and are delivered as events, so a
          // client can surface them as they become available without
          // holding the manifest (status() does not return it).
          const manifest = await rt.requireManifest();
          const hint = manifest.hints[Number(timer.ref)];
          if (hint) {
            await rt.recordHintDelivered({ index: Number(timer.ref), after_minutes: hint.after_minutes, text: hint.text });
            emitEvent(rt, 'hint', {
              index: Number(timer.ref),
              after_minutes: hint.after_minutes,
              text: hint.text,
            });
            // The last hint can be what earns the solution.
            await tryEmitSolutionUnlocked(rt, manifest);
          }
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
        case 'purge':
          if (await runPurge(rt)) {
            // Storage is gone, including the timer list; nothing later in this
            // batch can run against it.
            await rt.storage.deleteAlarm();
            return;
          }
          break;
      }
    } catch (err) {
      emitEvent(rt, 'alert', { kind: 'timer_failed', timer: timer.kind, ref: timer.ref, error: String(err) });
      if (timer.kind === 'start' || timer.kind === 'resume') {
        await endSession(rt, 'error').catch(() => {});
        // A cancel may have ended the session while the call that threw was in
        // flight, after endSession had destroyed the container, and that call
        // may have brought it back. Destroy whatever this session is bound to.
        if ((await rt.meta().catch(() => undefined))?.state === 'ended') {
          await Promise.resolve()
            .then(() => rt.backend().destroy())
            .catch(() => {});
        }
      }
      await rescheduleRecurring(rt, timer.kind).catch(() => {});
    }
  }
  await rearmAlarm(rt);
}

/**
 * Runs one `start` or `resume` timer: the boot itself, bounded and guarded.
 *
 * - Only for a session still in the matching state; anything else (ended,
 *   already running) just drops the watchdog.
 * - Never two boots at once in one instance: while `rt.bootInFlight` is set,
 *   a watchdog that comes due finds a live boot and leaves it alone (it stays
 *   queued, re-armed by handleAlarm, and looks again later). Alarm handlers do
 *   not overlap on the platform either; this is the in-memory backstop. An
 *   eviction clears the flag along with the boot it guarded, so the next
 *   watchdog legitimately retries.
 * - Counts attempts in `meta.boot_attempts`, persisted before the boot so a
 *   boot that keeps getting killed is counted, and ends the session as
 *   `error` instead of starting attempt MAX_BOOT_ATTEMPTS + 1.
 */
async function runBoot(rt: SessionRuntime, timer: TimerEntry): Promise<void> {
  if (rt.bootInFlight) return;
  const meta = await rt.requireMeta();
  if (meta.state !== BOOT_STATE[timer.kind]) {
    await cancelTimer(rt, timer.kind, timer.ref);
    return;
  }
  const attempt = (meta.boot_attempts ?? 0) + 1;
  if (attempt > MAX_BOOT_ATTEMPTS) {
    emitEvent(rt, 'alert', { kind: 'boot_gave_up', timer: timer.kind, attempts: meta.boot_attempts });
    await endSession(rt, 'error');
    return;
  }
  await rt.patchMeta({ boot_attempts: attempt });
  rt.bootInFlight = true;
  try {
    if (timer.kind === 'start') await runStart(rt, attempt);
    else await runResume(rt, attempt);
  } finally {
    rt.bootInFlight = false;
  }
  // Finished, or found the session ended under it: the watchdog is not needed.
  await cancelTimer(rt, timer.kind, timer.ref);
}

/**
 * Re-arms a recurring timer whose handler threw. Skips when the session is
 * over, and when a timer of that kind is already queued (the handler may have
 * re-scheduled itself before it threw), so it can never double-schedule.
 */
async function rescheduleRecurring(rt: SessionRuntime, kind: TimerKind): Promise<void> {
  const interval = RECURRING[kind];
  if (interval === undefined) return;
  if ((await rt.requireMeta()).state === 'ended') return;
  if ((await rt.timers()).some((t) => t.kind === kind)) return;
  await scheduleTimer(rt, kind, Date.now() + interval);
}

async function runHealthTick(rt: SessionRuntime): Promise<void> {
  const meta = await rt.requireMeta();
  if (
    (meta.state === 'recovering' && Date.now() - (meta.recovering_since ?? 0) > RECOVERING_TIMEOUT_MS) ||
    (meta.recover_failures ?? 0) >= MAX_RECOVER_FAILURES
  ) {
    await endSession(rt, 'error');
    return;
  }
  if (meta.state === 'recovering') {
    // Not stale yet. Keep polling, otherwise nothing would ever notice a
    // recovery that never finishes (this early return does not re-arm).
    await scheduleTimer(rt, 'health', Date.now() + HEALTH_INTERVAL_IDLE_MS);
    return;
  }
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
  await rt.patchMeta({ state: 'recovering', recovering_since: Date.now() });
  try {
    emitEvent(rt, 'container.restarted', { reason });

    await rt.backend().ensureRunning();

    const snapshots = await rt.snapshots();
    const manifest = await rt.requireManifest();
    if (snapshots[0]) {
      await rt.backend().restoreBackup({ id: snapshots[0].backup_id, dir: snapshots[0].dir });
      await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
    } else if (await workspaceSurvived(rt)) {
      // The container was replaced, but /workspace still has files in it, so
      // the filesystem did not go with it — re-hydrating here would overwrite
      // the learner's work with the published bundle and call it recovery.
      // Second line of defence behind allServicesGone's port probe: a restart
      // that lost nothing must not be "recovered" into one that lost
      // everything.
      emitEvent(rt, 'alert', {
        kind: 'recover_workspace_kept',
        message: 'Container was replaced but the workspace survived; leaving your files untouched.',
      });
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
      LLM_BASE_URL: llmBaseUrl(rt.env),
      LLM_MODEL: rt.env.LLM_MODEL,
      ...manifest.env,
    });

    await applyEgressAllowlist(rt, manifest);
    await relaunchAllServices(rt);
    await resetTerminal(rt);

    await rt.patchMeta({ state: 'running', recovering_since: undefined, recover_failures: undefined });
    emitEvent(rt, 'session.state', { state: 'running', recovered: true });
  } catch (err) {
    // Never leave the session in `recovering`: the health tick skips it, and
    // recover() refuses to re-enter it, so a throw here used to wedge the
    // session until DELETE. Go back to `running` so the next health tick
    // retries; runHealthTick ends the session after repeated failures.
    emitEvent(rt, 'alert', { kind: 'recover_failed', error: String(err) });
    await rt.patchMeta({
      state: 'running',
      recovering_since: undefined,
      recover_failures: (meta.recover_failures ?? 0) + 1,
    });
  }
}

/**
 * Whether /workspace still holds files. Fails closed: if the listing itself
 * errors we cannot claim the work survived, so we report false and let the
 * caller re-hydrate, which is the behaviour that at least leaves a usable
 * lab.
 */
async function workspaceSurvived(rt: SessionRuntime): Promise<boolean> {
  try {
    const listed = await rt.backend().listFiles('/workspace');
    return (listed.files?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The OpenAI-compatible endpoint lab code calls, with no credential of its
 * own — `llmOutbound` injects one on the way out, so the container never
 * holds a key. The account id and gateway name are not secret; the token is.
 */
function llmBaseUrl(env: SessionRuntime['env']): string {
  return `https://${env.LLM_HOST}/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/compat`;
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

  // The user's one-session slot. The route took it (D1 row `ended` ->
  // `resuming`, which the unique index refuses while another session is
  // live) before calling here; a resume whose row does not say so did not go
  // through that fence and must not start a second container for the user.
  const row = await sessionRowState(rt.env, rt.sessionId);
  if (row !== 'resuming') {
    const other = (await activeSessionRows(rt.env, meta.user_id)).find((r) => r.id !== rt.sessionId);
    if (other) throw ApiError.conflict('active_session_exists', `This user already has an active session (${other.id})`);
    throw ApiError.conflict('cannot_resume', 'The session slot was not reserved for this resume; use POST /sessions/:id/resume');
  }
  // The D1 read let other events in; a concurrent resume may have won.
  if ((await rt.requireMeta()).state !== 'ended') throw ApiError.conflict('cannot_resume', 'Session is already resuming');

  const now = Date.now();
  const next = await rt.patchMeta({ state: 'resuming', resuming_since: now, boot_attempts: undefined });
  await scheduleTimer(rt, 'resume', now);
  emitEvent(rt, 'session.state', { state: 'resuming' });

  // A resume grants a fresh full timeout budget (runResume sets
  // `expires_at` to now + timeout_minutes), so the token has to cover that
  // whole new window, not a flat hour.
  const manifest = await rt.requireManifest();
  const token = await mintSessionToken(rt.env, {
    sid: rt.sessionId,
    uid: meta.user_id,
    exp: sessionTokenExp(now + manifest.timeout_minutes * 60_000),
  });
  return { meta: next, token };
}

/**
 * The resume sequence, run from the `resume` timer. Retry-safe and cancel-safe
 * in the same ways as runStart (see there): the claim is reused, restoring the
 * same snapshot again gives the same result (the session is not running, so
 * nobody has written to /workspace since), and every container step is
 * followed by a check that destroys the container if the session ended.
 */
async function runResume(rt: SessionRuntime, attempt = 1): Promise<void> {
  const meta = await rt.requireMeta();
  // A DELETE can end the session while it is `resuming`. The resume timer may
  // already be due by then; running it would claim a container and flip the
  // session to `running` while D1 says ended.
  if (meta.state !== 'resuming') return;
  const manifest = await rt.requireManifest();
  const snapshots = await rt.snapshots();
  const latest = snapshots[0];
  if (!latest) throw new Error('resume fired with no snapshot');

  // The `resume` timer is deliberately retryable: if the DO is evicted
  // mid-resume the alarm runs this again. endSession cleared `sandbox_id`, so
  // the first run claims a fresh container from the pool and records it; a
  // retry then reuses that claim instead of taking a second one whose id
  // would be overwritten and never destroyed.
  const sandboxId = meta.sandbox_id ?? (await (await pool(rt, meta.family)).claim(rt.sessionId)).sandbox_id;
  const abandoned = () => abandonIfEnded(rt, meta.family, sandboxId);
  if (await abandoned()) return; // ended while the claim was in flight
  if (meta.sandbox_id !== sandboxId) await rt.patchMeta({ sandbox_id: sandboxId });
  await rt.bindBackend(meta.family, sandboxId);
  await rt.backend().ensureRunning();
  if (await abandoned()) return;

  await rt.backend().restoreBackup({ id: latest.backup_id, dir: latest.dir });
  if (await abandoned()) return;
  await hydratePressureScripts(rt, meta.lab_slug, meta.lab_version);
  if (await abandoned()) return;

  const llmToken = await mintLlmToken(rt.env, rt.sessionId);
  await applySessionEnv(rt, {
    OPALIX_SESSION_ID: rt.sessionId,
    OPALIX_SESSION_TOKEN: llmToken,
    OPALIX_BASE_URL: rt.env.PUBLIC_BASE_URL,
    LLM_BASE_URL: llmBaseUrl(rt.env),
    LLM_MODEL: rt.env.LLM_MODEL,
    ...manifest.env,
  });
  if (await abandoned()) return;
  await applyEgressAllowlist(rt, manifest);
  if (await abandoned()) return;
  await startAllServices(rt, manifest, { stopRecorded: attempt > 1 });
  if (await abandoned()) return;
  await rt.putTerminal(undefined);

  const now = Date.now();
  const expiresAt = now + manifest.timeout_minutes * 60_000;
  // running_s / usd carry over from before the end; only the accounting
  // cursor moves, so the time the session spent ended is not billed.
  await rt.putCost({ ...(await rt.cost()), accounted_until: now });
  const next = await rt.patchMeta({
    state: 'running',
    started_at: now,
    expires_at: expiresAt,
    last_input_at: now,
    resumed_count: meta.resumed_count + 1,
    ended_at: undefined,
    end_reason: undefined,
    boot_attempts: undefined,
    resuming_since: undefined,
  });

  // Ended sessions are on a cleanup/purge schedule; a live one must not be.
  await cancelTimersOfKind(rt, 'cleanup', 'purge');

  await scheduleRunTimers(rt, manifest, now, expiresAt);

  bestEffort(updateSession(rt.env, next), 'updateSession(resumed)');
  emitEvent(rt, 'session.state', { state: 'running', resumed: true });
}

/** `DELETE /sessions/{id}` and every automatic end path (idle/expired/error). */
export async function endSession(rt: SessionRuntime, reason: SnapshotEntry['reason'] | 'user' | 'unclaimed', snapshot = true): Promise<void> {
  const meta = await rt.requireMeta();
  if (meta.state === 'ended') return; // idempotent

  // Last tick, so the cost D1 records is not up to a metrics interval stale.
  // Only a session that was actually running has time left to account for,
  // and this must never stop the session from ending.
  if (meta.state === 'running' || meta.state === 'recovering') {
    await tickMetrics(rt).catch((err) => emitEvent(rt, 'alert', { kind: 'final_metrics_failed', error: String(err) }));
  }

  if (snapshot && meta.sandbox_id && (meta.state === 'running' || meta.state === 'recovering')) {
    await snapshotNow(rt, reason === 'unclaimed' ? 'user' : reason).catch((err) =>
      emitEvent(rt, 'alert', { kind: 'snapshot_on_end_failed', error: String(err) })
    );
  }

  if (meta.sandbox_id) {
    // Inside the promise chain: an unbound backend throws synchronously, and
    // that must not stop the session from ending (it would then never end).
    await Promise.resolve()
      .then(() => rt.backend().destroy())
      .catch(() => {});
    await (await pool(rt, meta.family)).release(meta.sandbox_id).catch(() => {});
  } else if (meta.state === 'starting' || meta.state === 'resuming') {
    // A boot killed between Pool.claim and storing `sandbox_id` holds a claim
    // this session never recorded; it would count against admission until the
    // pool's 2h15m reap. Give back whatever the pool says this session holds.
    await releaseUnrecordedClaims(rt, meta.family);
  }
  rt.upstreamTerminalSocket?.close();
  rt.upstreamTerminalSocket = undefined;
  rt.upstreamTerminalHandle = undefined;

  const now = Date.now();
  // Clear the container binding: the id was just destroyed and released, and
  // keeping it would let a resume re-bind it (`meta.sandbox_id ?? claim()`),
  // bypassing the pool. `last_sandbox_id` remembers it.
  const next = await rt.patchMeta({
    state: 'ended',
    ended_at: now,
    end_reason: reason,
    sandbox_id: undefined,
    last_sandbox_id: meta.sandbox_id ?? meta.last_sandbox_id,
    boot_attempts: undefined,
    resuming_since: undefined,
  });

  // Every kind, not a fixed list: pressure and hint timers carry refs, so a
  // per-kind cancelTimer() never matched them, and they woke the ended DO.
  await cancelTimersExcept(rt, 'cleanup');
  await scheduleTimer(rt, 'cleanup', now + CLEANUP_AFTER_MS);

  const finalCost = await rt.cost().catch(() => undefined);
  const hintsDelivered = await rt.hintsDelivered().then((h) => h.length, () => undefined);
  await persistEnded(
    rt.env,
    next,
    finalCost && { cost_usd: finalCost.usd, llm_usd: finalCost.llm_usd, running_s: Math.round(finalCost.running_s), hints_delivered: hintsDelivered }
  );
  emitEvent(rt, 'session.state', { state: 'ended', reason });
}

/** See endSession: destroys and releases every container the pool has on record for this session. Never throws. */
async function releaseUnrecordedClaims(rt: SessionRuntime, family: Family): Promise<void> {
  try {
    const ids = await (await pool(rt, family)).releaseSession(rt.sessionId);
    for (const id of ids) await destroyQuietly(rt, family, id);
  } catch {
    /* the pool's reaper is the backstop */
  }
}

/**
 * Ends a session that has been stuck in `starting`, `resuming` or
 * `recovering` for STUCK_BOOT_MS (state.isStuck), as `error` and without a
 * snapshot, through the normal end path so its container and pool claim are
 * released and D1 is closed. Resolves the ended meta, or null when the session
 * is not stuck (it may have finished booting since the caller looked). Called
 * through the Session DO by reconcile.healIfStale, which the start routes and
 * the sweeper use.
 */
export async function endIfStuck(rt: SessionRuntime, now = Date.now()): Promise<SessionMeta | null> {
  const meta = await rt.meta();
  if (!meta || !isStuck(meta, now)) return null;
  emitEvent(rt, 'alert', { kind: 'stuck_boot', state: meta.state });
  await endSession(rt, 'error', false);
  return rt.requireMeta();
}

/** Waits before the 2nd, 3rd and 4th attempt at the final D1 write of an ended session. */
export const END_WRITE_RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * The write that closes a session's D1 row. A lost write leaves the row
 * active, and the unique index then locks the learner out of starting
 * another session, so this one is awaited and retried rather than fired
 * and forgotten. If every attempt fails it degrades to `bestEffort` (one
 * last try that only logs) and the hourly sweeper is the backstop.
 */
export async function persistEnded(
  env: Env,
  meta: SessionMeta,
  cost?: SessionCostRow,
  delaysMs: number[] = END_WRITE_RETRY_DELAYS_MS
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await updateSession(env, meta, cost);
      return;
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined) {
        console.error(`d1 write failed after ${attempt + 1} attempts (updateSession(ended)):`, err);
        bestEffort(updateSession(env, meta, cost), 'updateSession(ended)');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Drops the SQL event log and most storage keys an hour after end, keeping only what a resume or history view needs. */
async function runCleanup(rt: SessionRuntime): Promise<void> {
  rt.sql.exec('DELETE FROM events');
  await rt.putServices({});
  await rt.putTerminal(undefined);
  await rt.putPressureStatus({});
  // The last check run was already written to D1 when it finished; the
  // rendered env is only useful to a live container.
  await rt.clearSessionEnv();
  await rt.clearLastChecks();

  const snapshots = await rt.snapshots();
  const purgeAt =
    snapshots.length > 0
      ? Math.max(...snapshots.map((s) => s.created_at + s.ttl * 1000))
      : Date.now() + PURGE_DEFAULT_AFTER_MS;
  await scheduleTimer(rt, 'purge', purgeAt);
}

/**
 * Last act of a session's Durable Object: once its snapshots have expired
 * there is nothing left worth keeping, so drop all storage (meta, manifest,
 * snapshots, cost, timers) and the alarm. Returns whether it purged; a session
 * that has been resumed since cleanup was scheduled is left alone.
 */
async function runPurge(rt: SessionRuntime): Promise<boolean> {
  const meta = await rt.meta();
  if (meta && meta.state !== 'ended') return false;
  await rt.storage.deleteAll();
  await rt.storage.deleteAlarm();
  return true;
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
