import { DurableObject } from 'cloudflare:workers';
import type { Env, Family } from '../env';
import { cloudflareBackend } from '../session/backend';
import { newId } from '../lib/ids';
import { isFamily } from '../families/registry';

interface WarmEntry {
  sandbox_id: string;
  created_at: number;
  ready_at: number;
  last_ping_at: number;
}

interface ClaimedEntry {
  session_id: string;
  claimed_at: number;
  /** Whether this sandbox came off the warm list. Absent on entries written before claims were made idempotent. */
  warm?: boolean;
}

interface PoolConfig {
  family: Family;
  target: number;
  batch: number;
  ping_every_s: number;
}

interface PoolStats {
  claims: number;
  warm_hits: number;
  cold_misses: number;
  starts: number;
  start_ms_total: number;
  failures: number;
  capacity_backoff_until: number;
}

const REFILL_INTERVAL_MS = 30_000;
const CLAIMED_REAP_MS = 3 * 60 * 60 * 1000; // 3h: a session that never released is treated as orphaned

const defaultStats = (): PoolStats => ({
  claims: 0,
  warm_hits: 0,
  cold_misses: 0,
  starts: 0,
  start_ms_total: 0,
  failures: 0,
  capacity_backoff_until: 0,
});

/**
 * One Pool DO per lab family (`env.POOL.idFromName(family)`). Keeps a small
 * number of pre-started containers so `POST /sessions` doesn't wait out a
 * full cold start on the common path. There is no upstream WarmPool on
 * `@cloudflare/sandbox@next` (it shipped only for the stable bridge), so
 * this is a deliberately small reimplementation: claim/release plus one
 * alarm loop that pings, refills, and reaps.
 */
export class Pool extends DurableObject<Env> {
  /**
   * Called by the cron safety kick (index.ts's `scheduled()`). Always
   * ensures the alarm loop is running, even if `getConfig()`'s lazy
   * initialization (target 0, no alarm) already created the config row
   * because something queried this Pool before the cron's first tick —
   * relying on "was this the first-ever call" to decide whether to arm the
   * alarm would leave the pool permanently unrefilled in that ordering.
   */
  async initConfig(family: Family, target: number): Promise<void> {
    const existing = await this.ctx.storage.get<PoolConfig>('config');
    if (!existing) {
      await this.ctx.storage.put<PoolConfig>('config', { family, target, batch: 3, ping_every_s: 240 });
      await this.ctx.storage.put<PoolStats>('stats', defaultStats());
    } else if (existing.target !== target) {
      await this.ctx.storage.put<PoolConfig>('config', { ...existing, target });
    }
    await this.scheduleAlarm();
  }

  /**
   * Lazily initializes with target 0 if the cron's `initConfig` hasn't run
   * yet (e.g. in the first few minutes after a fresh deploy, or if the
   * cron trigger is ever removed). `stats()`/`claim()`/`prime()` all go
   * through this, so a Pool DO queried before its first cron tick reports
   * "empty, no target" instead of a 500 — the cron's next real
   * `initConfig` call still updates the target normally.
   */
  private async getConfig(): Promise<PoolConfig> {
    const config = await this.ctx.storage.get<PoolConfig>('config');
    if (config) return config;
    const family = this.ctx.id.name;
    if (!family || !isFamily(family)) {
      throw new Error('Pool DO must be addressed via idFromName(family)');
    }
    const fresh: PoolConfig = { family, target: 0, batch: 3, ping_every_s: 240 };
    await this.ctx.storage.put<PoolConfig>('config', fresh);
    await this.ctx.storage.put<PoolStats>('stats', defaultStats());
    return fresh;
  }

  private async getWarm(): Promise<WarmEntry[]> {
    return (await this.ctx.storage.get<WarmEntry[]>('warm')) ?? [];
  }
  private async setWarm(warm: WarmEntry[]): Promise<void> {
    await this.ctx.storage.put('warm', warm);
  }
  private async getClaimed(): Promise<Record<string, ClaimedEntry>> {
    return (await this.ctx.storage.get<Record<string, ClaimedEntry>>('claimed')) ?? {};
  }
  private async setClaimed(claimed: Record<string, ClaimedEntry>): Promise<void> {
    await this.ctx.storage.put('claimed', claimed);
  }
  private async bumpStats(patch: Partial<PoolStats>): Promise<void> {
    const stats = (await this.ctx.storage.get<PoolStats>('stats')) ?? defaultStats();
    await this.ctx.storage.put('stats', { ...stats, ...patch });
  }

  /**
   * Pops a warm sandbox for `sessionId`, or mints a cold id for the Session
   * DO to start itself.
   *
   * Idempotent per session: if `sessionId` already holds a claim, the same
   * sandbox id is replayed instead of a second container being taken. A
   * single `POST /sessions` can reach here twice — the Session DO's `start`
   * alarm is redelivered when `runStart()` throws before its state commits,
   * and a DO RPC whose response is lost is retried against a Pool that
   * already ran it. Without this, the Session DO keeps only the second
   * sandbox id in `meta.sandbox_id`, so its `end()` never destroys the
   * first one and it sits in `claimed` burning money until the 3h reap.
   * Measured on 2026-09-24: one session moved `claims` 22 -> 24.
   */
  async claim(sessionId: string): Promise<{ sandbox_id: string; warm: boolean }> {
    const config = await this.getConfig();
    const warm = await this.getWarm();
    const claimed = await this.getClaimed();
    const stats = (await this.ctx.storage.get<PoolStats>('stats')) ?? defaultStats();

    const held = Object.entries(claimed).find(([, e]) => e.session_id === sessionId);
    if (held) return { sandbox_id: held[0], warm: held[1].warm ?? false };

    const entry = warm.shift();
    await this.setWarm(warm);

    const sandboxId = entry ? entry.sandbox_id : `${config.family}-${newId()}`;
    claimed[sandboxId] = { session_id: sessionId, claimed_at: Date.now(), warm: Boolean(entry) };
    await this.setClaimed(claimed);
    await this.bumpStats({
      claims: stats.claims + 1,
      warm_hits: stats.warm_hits + (entry ? 1 : 0),
      cold_misses: stats.cold_misses + (entry ? 0 : 1),
    });

    await this.scheduleAlarm(0); // refill soon after a claim
    return { sandbox_id: sandboxId, warm: Boolean(entry) };
  }

  async release(sandboxId: string): Promise<void> {
    const claimed = await this.getClaimed();
    delete claimed[sandboxId];
    await this.setClaimed(claimed);
  }

  async stats(): Promise<{ warm: number; claimed: number; config: PoolConfig; stats: PoolStats }> {
    const [config, warm, claimed, stats] = await Promise.all([
      this.getConfig(),
      this.getWarm(),
      this.getClaimed(),
      this.ctx.storage.get<PoolStats>('stats'),
    ]);
    return { warm: warm.length, claimed: Object.keys(claimed).length, config, stats: stats ?? defaultStats() };
  }

  /**
   * Sets a new target (if given) and reconciles immediately. `alarm()` moves
   * the pool in both directions, so lowering the target here destroys the
   * surplus rather than leaving it pinged alive forever.
   */
  async prime(target?: number): Promise<void> {
    const config = await this.getConfig();
    if (target !== undefined) {
      const next = Math.max(0, Math.floor(target));
      await this.ctx.storage.put<PoolConfig>('config', { ...config, target: next });
    }
    await this.alarm();
  }

  /** Destroys every warm (unassigned) container. Claimed containers are left untouched. */
  async drain(): Promise<void> {
    const warm = await this.getWarm();
    await this.setWarm([]);
    const config = await this.getConfig();
    await Promise.allSettled(warm.map((w) => cloudflareBackend(this.env, config.family, w.sandbox_id).destroy()));
  }

  private async scheduleAlarm(delayMs = REFILL_INTERVAL_MS): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const next = Date.now() + delayMs;
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const config = await this.getConfig();
    const now = Date.now();
    const stats = (await this.ctx.storage.get<PoolStats>('stats')) ?? defaultStats();

    // 1. Ping warm containers older than ping_every_s; drop and destroy failures.
    let warm = await this.getWarm();
    const stillWarm: WarmEntry[] = [];
    for (const w of warm) {
      if (now - w.last_ping_at < config.ping_every_s * 1000) {
        stillWarm.push(w);
        continue;
      }
      try {
        await cloudflareBackend(this.env, config.family, w.sandbox_id).ensureRunning();
        stillWarm.push({ ...w, last_ping_at: now });
      } catch {
        await this.bumpStats({ failures: stats.failures + 1 });
        void cloudflareBackend(this.env, config.family, w.sandbox_id).destroy().catch(() => {});
      }
    }
    warm = stillWarm;

    // 2. Reconcile toward target in both directions. Refilling is skipped
    //    during a capacity backoff window; shrinking never is, since giving
    //    containers back is exactly what we want while capacity is tight.
    const target = Math.max(0, config.target);
    const deficit = target - warm.length;
    if (deficit < 0) {
      // Surplus, i.e. the target was lowered (by `prime`, or by the 5-minute
      // cron re-applying POOL_TARGET_*). Destroy from the tail so the oldest
      // warm entries — the ones the next claim will hand out — are kept.
      // Without this the ping loop in step 1 keeps paid containers alive
      // for ever: observed on 2026-09-24, a pool primed 2 -> 1 stayed at
      // warm: 2 indefinitely.
      const surplus = warm.splice(target);
      await this.setWarm(warm);
      await Promise.allSettled(surplus.map((w) => cloudflareBackend(this.env, config.family, w.sandbox_id).destroy()));
    } else if (deficit > 0 && stats.capacity_backoff_until < now) {
      const toStart = Math.min(deficit, config.batch);
      const results = await Promise.allSettled(
        Array.from({ length: toStart }, async () => {
          const sandboxId = `${config.family}-${newId()}`;
          const startedAt = Date.now();
          await cloudflareBackend(this.env, config.family, sandboxId).ensureRunning();
          return { sandbox_id: sandboxId, created_at: startedAt, ready_at: Date.now(), last_ping_at: Date.now() };
        })
      );
      let started = 0;
      let startMs = 0;
      let capacityHit = false;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          warm.push(r.value);
          started += 1;
          startMs += r.value.ready_at - r.value.created_at;
        } else {
          const name = (r.reason as { name?: string } | undefined)?.name;
          if (name === 'container_unavailable' || name?.startsWith('ApiError')) capacityHit = true;
        }
      }
      const updatedStats = (await this.ctx.storage.get<PoolStats>('stats')) ?? defaultStats();
      await this.bumpStats({
        starts: updatedStats.starts + started,
        start_ms_total: updatedStats.start_ms_total + startMs,
        capacity_backoff_until: capacityHit ? now + 5 * 60_000 : updatedStats.capacity_backoff_until,
      });
    }
    await this.setWarm(warm);

    // 3. Reap claimed entries no one ever released (orphaned sessions).
    const claimed = await this.getClaimed();
    for (const [sandboxId, entry] of Object.entries(claimed)) {
      if (now - entry.claimed_at > CLAIMED_REAP_MS) {
        delete claimed[sandboxId];
        void cloudflareBackend(this.env, config.family, sandboxId).destroy().catch(() => {});
      }
    }
    await this.setClaimed(claimed);

    await this.scheduleAlarm();
  }
}

/** Looked up by the family cron kick and by Session DO's claim/release calls. */
export function poolStub(env: Env, family: Family): DurableObjectStub<Pool> {
  if (!isFamily(family)) throw new Error(`Unknown family "${family}"`);
  return env.POOL.get(env.POOL.idFromName(family));
}
