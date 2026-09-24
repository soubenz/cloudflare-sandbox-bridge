import type { Env, Family } from '../env';
import type { Terminal } from '@cloudflare/sandbox';
import type { LabManifest, ServiceSpec } from '../labs/manifest';
import type { Backend } from './backend';

export type SessionState = 'created' | 'starting' | 'running' | 'recovering' | 'resuming' | 'ended';
export type EndReason = 'user' | 'idle' | 'expired' | 'error' | 'evicted';

export interface SessionMeta {
  id: string;
  user_id: string;
  lab_slug: string;
  lab_version: string;
  family: Family;
  sandbox_id?: string;
  state: SessionState;
  created_at: number;
  started_at?: number;
  expires_at?: number;
  last_input_at?: number;
  ended_at?: number;
  end_reason?: EndReason;
  resumed_count: number;
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
  | 'health'
  | 'metrics'
  | 'cleanup';

export interface TimerEntry {
  at: number;
  kind: TimerKind;
  ref?: string; // e.g. a pressure event id
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

export interface CostState {
  running_s: number;
  usd: number;
  llm_usd: number;
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
  cost: 'cost',
  sessionEnv: 'session_env',
} as const;

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
    const next = { ...meta, ...patch };
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

  async cost(): Promise<CostState> {
    return (await this.storage.get<CostState>(KEYS.cost)) ?? { running_s: 0, usd: 0, llm_usd: 0 };
  }
  async putCost(cost: CostState): Promise<void> {
    await this.storage.put(KEYS.cost, cost);
  }

  /** Lazily built; rebuilt if the sandbox id changes across a resume. */
  backend(): Backend {
    if (!this._backend) throw new Error('Backend not initialized; call bindBackend() after meta has a sandbox_id');
    return this._backend;
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
