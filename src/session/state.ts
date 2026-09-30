import type { Env, Family } from '../env';
import type { Terminal } from '@cloudflare/sandbox';
import type { LabManifest, ServiceSpec } from '../labs/manifest';
import type { Backend } from './backend';
import type { SolutionStatus } from './solution';
import { ApiError } from '../lib/errors';

export type SessionState = 'created' | 'starting' | 'running' | 'recovering' | 'resuming' | 'ended';
export type EndReason = 'user' | 'idle' | 'expired' | 'error' | 'evicted';

export interface SessionMeta {
  id: string;
  user_id: string;
  lab_slug: string;
  lab_version: string;
  family: Family;
  sandbox_id?: string;
  /** The container this session last held. `sandbox_id` is cleared on end so a resume claims a fresh one; this keeps the old id for diagnosis. */
  last_sandbox_id?: string;
  state: SessionState;
  created_at: number;
  started_at?: number;
  expires_at?: number;
  last_input_at?: number;
  ended_at?: number;
  end_reason?: EndReason;
  resumed_count: number;
  /** When the current `recovering` spell began; cleared on success or failure. Lets the health tick end a recovery that never finishes. */
  recovering_since?: number;
  /** Consecutive failed recover() runs since the last success. */
  recover_failures?: number;
  /**
   * Hash of the address that opened the session, for the dev route's
   * per-address cap. Never shown, never reversed, and absent for sessions
   * started with the service key.
   */
  ip_hash?: string;
}

export type ServiceHealth = 'unknown' | 'healthy' | 'unhealthy';

export interface ServiceRuntime {
  spec: ServiceSpec;
  process_id?: string;
  pid?: number;
  started_at?: number;
  restarts: number;
  health: ServiceHealth;
  last_health_at?: number;
}

export interface TerminalRuntime {
  id: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  cursor?: string;
}

export type TimerKind =
  | 'start'
  | 'resume'
  | 'idle'
  | 'idle_warn'
  | 'hard'
  | 'hard_warn'
  | 'pressure'
  | 'hint'
  | 'health'
  | 'metrics'
  | 'cleanup'
  | 'purge';

export interface TimerEntry {
  at: number;
  kind: TimerKind;
  ref?: string; // e.g. a pressure event id, or a hint's index
}

export interface SnapshotEntry {
  backup_id: string;
  dir: string;
  name?: string;
  ttl: number;
  created_at: number;
  reason: 'user' | 'idle' | 'expired' | 'error';
}

export type PressureStatus = 'pending' | 'fired' | 'failed';

export interface CheckResultEntry {
  name: string;
  pass: boolean;
  message: string;
  duration_ms: number;
  exit_code: number;
  timed_out: boolean;
  weight: number;
}

export interface ChecksRun {
  run_id: string;
  started_at: number;
  finished_at?: number;
  results: CheckResultEntry[];
}

/** One hint that has unlocked, as delivered in the `hint` event. */
export interface HintDelivered {
  index: number;
  after_minutes: number;
  text: string;
}

/**
 * A finished check run, kept compactly for `status().checks_history`:
 * per-check name, verdict and weight but not the message, so ten of them
 * stay far under the 128 KiB storage value limit. The full run is in D1.
 */
export interface CheckHistoryEntry {
  run_id: string;
  started_at: number;
  finished_at?: number;
  passed: number;
  total: number;
  score: number;
  results: Array<{ name: string; pass: boolean; weight: number }>;
}

/** How many runs `checks_history` keeps. */
export const CHECKS_HISTORY_CAP = 10;

export interface CostState {
  running_s: number;
  usd: number;
  llm_usd: number;
  /** Compute time up to this instant (ms) is already in `running_s`. Set on each metrics tick and at resume, so the ended gap is never billed. */
  accounted_until?: number;
}

export interface ManifestSummary {
  title: string;
  objectives: string[];
  timeout_minutes: number;
  idle_minutes: number;
  checks: Array<{ name: string; weight: number }>;
  services: Array<{ name: string; ui: boolean; port?: number }>;
  hints_schedule: number[];
}

/** What `GET /sessions/:id` (the Session DO's `status()`) returns. Documented in docs/api.md. */
export interface SessionStatus {
  meta: SessionMeta;
  services: Record<string, ServiceRuntime>;
  snapshots: SnapshotEntry[];
  checks?: ChecksRun;
  cost: CostState;
  hints: { delivered: HintDelivered[]; total: number; schedule: number[] };
  /** Per pressure event id: `pending` until it fires, then `fired` or `failed` (with `fired_at`). */
  pressure: Record<string, { status: PressureStatus; fired_at?: number }>;
  /** Absent once the session's storage has been purged of its manifest. */
  manifest_summary?: ManifestSummary;
  /** The last 10 finished check runs, oldest first, without per-check messages. */
  checks_history: CheckHistoryEntry[];
  /** Whether this lab has a solution to reveal, and whether this session has earned it. See session/solution.ts. */
  solution: SolutionStatus;
  /** Epoch ms on the server, so a client can correct for clock skew when counting down to `meta.expires_at`. */
  server_time: number;
}

export function summarizeManifest(manifest: LabManifest): ManifestSummary {
  return {
    title: manifest.title,
    objectives: manifest.objectives,
    timeout_minutes: manifest.timeout_minutes,
    idle_minutes: manifest.idle_minutes,
    checks: manifest.checks.map((c) => ({ name: c.name, weight: c.weight })),
    services: manifest.services.map((s) => ({ name: s.name, ui: s.ui, ...(s.port !== undefined ? { port: s.port } : {}) })),
    hints_schedule: manifest.hints.map((h) => h.after_minutes),
  };
}

/** Assembles the status() body from what the DO has stored. Pure. */
export function buildStatus(input: {
  meta: SessionMeta;
  services: Record<string, ServiceRuntime>;
  snapshots: SnapshotEntry[];
  checks?: ChecksRun;
  cost: CostState;
  manifest?: LabManifest;
  delivered: HintDelivered[];
  pressure: Record<string, { status: PressureStatus; fired_at?: number }>;
  checksHistory: CheckHistoryEntry[];
  solution: SolutionStatus;
  now: number;
}): SessionStatus {
  const { manifest, meta } = input;
  const schedule = manifest?.hints.map((h) => h.after_minutes) ?? [];
  // Events that have not fired are `pending`, so a client can list them all
  // without holding the manifest. Once the session has ended none is coming.
  const pressure = { ...input.pressure };
  if (manifest && meta.state !== 'ended') {
    for (const event of manifest.pressure) pressure[event.id] ??= { status: 'pending' };
  }
  return {
    meta,
    services: input.services,
    snapshots: input.snapshots,
    checks: input.checks,
    cost: input.cost,
    hints: { delivered: input.delivered, total: schedule.length, schedule },
    pressure,
    manifest_summary: manifest ? summarizeManifest(manifest) : undefined,
    checks_history: input.checksHistory,
    solution: input.solution,
    server_time: input.now,
  };
}

const KEYS = {
  meta: 'meta',
  manifest: 'manifest',
  services: 'services',
  terminal: 'terminal',
  timers: 'timers',
  pressure: 'pressure',
  snapshots: 'snapshots',
  checksLast: 'checks:last',
  checksHistory: 'checks:history',
  checkRuns: 'checks:count',
  checksCompleted: 'checks:completed',
  solutionUnlocked: 'solution:unlocked',
  hints: 'hints',
  cost: 'cost',
  sessionEnv: 'session_env',
} as const;

function notRunning(): ApiError {
  return ApiError.conflict('not_running', 'The session is not running (still starting, resuming, recovering or ended)');
}

/**
 * Bundles a Session Durable Object's storage, env, and lazily-created
 * Backend behind typed accessors, so every session/* module operates on
 * the same `rt: SessionRuntime` instead of each re-deriving a Backend or
 * re-typing storage keys. Created once per DO instance in do/session.ts's
 * constructor and passed into lifecycle/services/checks/etc.
 */
export class SessionRuntime {
  readonly storage: DurableObjectStorage;
  readonly sql: SqlStorage;
  readonly env: Env;
  readonly sessionId: string;
  private _backend?: Backend;
  private checkRunQueue: Promise<unknown> = Promise.resolve();
  private solutionClaimed = false;

  /** In-memory only — SSE writers for GET /events and the upstream terminal socket for WS /terminal. Never persisted; a DO restart drops both and clients reconnect. */
  readonly sseWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  upstreamTerminalSocket?: WebSocket;
  upstreamTerminalHandle?: Terminal;
  readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env, sessionId: string) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.env = env;
    this.sessionId = sessionId;
  }

  async meta(): Promise<SessionMeta | undefined> {
    return this.storage.get<SessionMeta>(KEYS.meta);
  }
  async requireMeta(): Promise<SessionMeta> {
    const meta = await this.meta();
    if (!meta) throw new Error(`Session ${this.sessionId} has no meta; not created`);
    return meta;
  }
  async putMeta(meta: SessionMeta): Promise<void> {
    await this.storage.put(KEYS.meta, meta);
  }
  async patchMeta(patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const meta = await this.requireMeta();
    const next: SessionMeta = { ...meta, ...patch };
    // An explicit `undefined` in the patch means "clear this field": drop the
    // key rather than store an undefined-valued one.
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    }
    await this.putMeta(next);
    return next;
  }

  async manifest(): Promise<LabManifest | undefined> {
    return this.storage.get<LabManifest>(KEYS.manifest);
  }
  async requireManifest(): Promise<LabManifest> {
    const manifest = await this.manifest();
    if (!manifest) throw new Error(`Session ${this.sessionId} has no manifest`);
    return manifest;
  }
  async putManifest(manifest: LabManifest): Promise<void> {
    await this.storage.put(KEYS.manifest, manifest);
  }

  async services(): Promise<Record<string, ServiceRuntime>> {
    return (await this.storage.get<Record<string, ServiceRuntime>>(KEYS.services)) ?? {};
  }
  async putServices(services: Record<string, ServiceRuntime>): Promise<void> {
    await this.storage.put(KEYS.services, services);
  }

  /**
   * The rendered session environment. Kept in DO storage, not only pushed
   * to the container: the SDK's setEnvVars() writes an in-memory field on
   * the Sandbox DO that it never restores after an eviction, so anything
   * exec'd later (a service restart, a pressure script) would otherwise
   * launch with none of the lab's declared env.
   */
  async sessionEnv(): Promise<Record<string, string>> {
    return (await this.storage.get<Record<string, string>>(KEYS.sessionEnv)) ?? {};
  }
  async putSessionEnv(vars: Record<string, string>): Promise<void> {
    await this.storage.put(KEYS.sessionEnv, vars);
  }

  async clearSessionEnv(): Promise<void> {
    await this.storage.delete(KEYS.sessionEnv);
  }

  async terminal(): Promise<TerminalRuntime | undefined> {
    return this.storage.get<TerminalRuntime>(KEYS.terminal);
  }
  async putTerminal(terminal: TerminalRuntime | undefined): Promise<void> {
    if (terminal === undefined) await this.storage.delete(KEYS.terminal);
    else await this.storage.put(KEYS.terminal, terminal);
  }

  async timers(): Promise<TimerEntry[]> {
    return (await this.storage.get<TimerEntry[]>(KEYS.timers)) ?? [];
  }
  async putTimers(timers: TimerEntry[]): Promise<void> {
    await this.storage.put(KEYS.timers, timers);
  }

  async pressureStatus(): Promise<Record<string, { status: PressureStatus; fired_at?: number }>> {
    return (await this.storage.get(KEYS.pressure)) ?? {};
  }
  async putPressureStatus(status: Record<string, { status: PressureStatus; fired_at?: number }>): Promise<void> {
    await this.storage.put(KEYS.pressure, status);
  }

  async snapshots(): Promise<SnapshotEntry[]> {
    return (await this.storage.get<SnapshotEntry[]>(KEYS.snapshots)) ?? [];
  }
  async putSnapshots(snapshots: SnapshotEntry[]): Promise<void> {
    await this.storage.put(KEYS.snapshots, snapshots);
  }

  async lastChecks(): Promise<ChecksRun | undefined> {
    return this.storage.get<ChecksRun>(KEYS.checksLast);
  }
  async putLastChecks(run: ChecksRun): Promise<void> {
    await this.storage.put(KEYS.checksLast, run);
  }

  async clearLastChecks(): Promise<void> {
    await this.storage.delete(KEYS.checksLast);
  }

  async checksHistory(): Promise<CheckHistoryEntry[]> {
    return (await this.storage.get<CheckHistoryEntry[]>(KEYS.checksHistory)) ?? [];
  }
  /** Appends a finished run, keeping the newest CHECKS_HISTORY_CAP (oldest first in storage). */
  async appendChecksHistory(entry: CheckHistoryEntry): Promise<void> {
    const history = [...(await this.checksHistory()), entry];
    await this.storage.put(KEYS.checksHistory, history.slice(-CHECKS_HISTORY_CAP));
  }

  /** How many check runs this session has finished. A counter of its own: `checksHistory` keeps only the last ten. */
  async checkRunCount(): Promise<number> {
    return (await this.storage.get<number>(KEYS.checkRuns)) ?? 0;
  }
  /**
   * Counts one finished run. `completed` is whether that run passed every
   * check the lab defines (the same test D1's `completed_at` uses); once set
   * it stays set, so a later failing run cannot take the solution away.
   */
  recordCheckRun(completed: boolean): Promise<void> {
    // Read-modify-write, and two runs can finish together: queue them so
    // neither reads the count the other is about to replace.
    const done = this.checkRunQueue.then(async () => {
      await this.storage.put(KEYS.checkRuns, (await this.checkRunCount()) + 1);
      if (completed) await this.storage.put(KEYS.checksCompleted, true);
    });
    this.checkRunQueue = done.catch(() => {});
    return done;
  }
  /** True once any run passed every check. */
  async checksCompleted(): Promise<boolean> {
    return (await this.storage.get<boolean>(KEYS.checksCompleted)) === true;
  }

  /** Whether the `solution.unlocked` event has been emitted for this session. Survives recovery and resume: it lives in DO storage. */
  async solutionUnlockedEmitted(): Promise<boolean> {
    return (await this.storage.get<boolean>(KEYS.solutionUnlocked)) === true;
  }
  /** Sets the flag; returns true only for the call that set it, so exactly one caller emits. */
  async markSolutionUnlockedEmitted(): Promise<boolean> {
    // Claimed synchronously, before any await, so concurrent callers in this
    // instance cannot both get past it; storage carries it across restarts.
    if (this.solutionClaimed) return false;
    this.solutionClaimed = true;
    try {
      if (await this.solutionUnlockedEmitted()) return false;
      await this.storage.put(KEYS.solutionUnlocked, true);
      return true;
    } catch (err) {
      this.solutionClaimed = false;
      throw err;
    }
  }

  async hintsDelivered(): Promise<HintDelivered[]> {
    return (await this.storage.get<HintDelivered[]>(KEYS.hints)) ?? [];
  }
  /** Records that a hint unlocked. Idempotent per index: a resume re-arms the timers, and a repeat must not double-count. */
  async recordHintDelivered(hint: HintDelivered): Promise<void> {
    const delivered = await this.hintsDelivered();
    if (delivered.some((h) => h.index === hint.index)) return;
    await this.storage.put(KEYS.hints, [...delivered, hint].sort((a, b) => a.index - b.index));
  }

  async cost(): Promise<CostState> {
    return (await this.storage.get<CostState>(KEYS.cost)) ?? { running_s: 0, usd: 0, llm_usd: 0 };
  }
  async putCost(cost: CostState): Promise<void> {
    await this.storage.put(KEYS.cost, cost);
  }

  /** Lazily built; rebuilt if the sandbox id changes across a resume. */
  backend(): Backend {
    if (!this._backend) throw notRunning();
    return this._backend;
  }
  /** Throws the 409 `not_running` unless the session is `running`. Guards every RPC that needs a live container. */
  async requireRunning(): Promise<void> {
    const meta = await this.meta();
    if (meta?.state !== 'running') throw notRunning();
  }
  /**
   * Dynamically imports backend.ts rather than importing `cloudflareBackend`
   * at module top level. backend.ts pulls in `@cloudflare/sandbox`, which
   * transitively imports the `cloudflare:workers` virtual module — fine
   * inside the Workers runtime, but unresolvable under plain Node, which is
   * what test/unit's fast, no-Miniflare unit tests run under (see
   * vitest.config.ts). Deferring the import means state.ts itself stays
   * plain-Node-safe; only a test that actually calls bindBackend() (none
   * currently do) would need the real runtime.
   */
  async bindBackend(family: Family, sandboxId: string): Promise<void> {
    const { cloudflareBackend } = await import('./backend');
    this._backend = cloudflareBackend(this.env, family, sandboxId);
  }

  /** Marks that the learner (or an automated check/restart) did something, resetting the idle clock. */
  async touchInput(): Promise<void> {
    await this.patchMeta({ last_input_at: Date.now() });
  }
}
