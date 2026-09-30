import { createRouter } from './router';
import type { Env } from './env';
import { poolTarget } from './families/registry';
import { poolStub } from './do/pool';
import { resolvePoolTarget } from './lib/pool-schedule';
import { deleteExpiredSnapshots, shouldSweepSnapshots } from './session/d1';
import { sweepStaleSessions } from './session/reconcile';

// Re-export every Durable Object class so wrangler can wire up bindings.
export { AgentLab } from './families/agent-lab';
export { GatewayLab } from './families/gateway-lab';
export { Pool } from './do/pool';
export { Session } from './do/session';

// Required by @cloudflare/containers whenever a Sandbox subclass sets
// `enableInternet`/`allowedHosts`/`outboundByHost` (both AgentLab and
// GatewayLab do): it looks up this export via `ctx.exports.ContainerProxy`
// to route outbound interception. Omitting it fails every container start
// with "ctx.exports.ContainerProxy is undefined" — found only by actually
// starting a session against the real deployment; nothing in the SDK docs
// consulted while planning this flagged the requirement.
export { ContainerProxy } from '@cloudflare/containers';

const app = createRouter();

export default {
  fetch: app.fetch,

  /** Safety-net pool kick, every 5 minutes: ensures each family's Pool DO has its config initialized and its alarm loop running, even if it was never primed via the API. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const family of ['agent', 'gateway'] as const) {
      const stub = poolStub(env, family);
      // Time-of-day target (POOL_SCHEDULE_<FAMILY>, UTC); the static POOL_TARGET_<FAMILY> var is the fallback.
      const schedule = family === 'agent' ? env.POOL_SCHEDULE_AGENT : env.POOL_SCHEDULE_GATEWAY;
      const target = resolvePoolTarget(schedule, poolTarget(env, family), new Date(controller.scheduledTime));
      ctx.waitUntil(
        (async () => {
          await stub.initConfig(family, target);
          // prime() only ever grows the pool, so shrink it explicitly when the target dropped.
          const { warm } = await stub.stats();
          if (warm > target) await stub.drain(target);
          await stub.prime();
        })()
      );
    }

    // Hourly: drop D1 snapshot rows past their TTL. R2 objects are expired by the bucket lifecycle rule (docs/runbooks/backups.md).
    if (shouldSweepSnapshots(controller.scheduledTime)) {
      ctx.waitUntil(
        deleteExpiredSnapshots(env, Date.now()).then(
          (deleted) => console.log(`snapshot sweep: deleted ${deleted} expired snapshot rows`),
          (err) => console.error('snapshot sweep failed:', err)
        )
      );

      // Same hourly gate: close D1 rows that still look active three hours
      // on, when their Session DO has ended or is gone. Each one holds its
      // user's only session slot until closed.
      ctx.waitUntil(
        sweepStaleSessions(env, Date.now()).then(
          ({ checked, healed }) => console.log(`session sweep: checked ${checked} stale active rows, healed ${healed}`),
          (err) => console.error('session sweep failed:', err)
        )
      );
    }
  },
};
