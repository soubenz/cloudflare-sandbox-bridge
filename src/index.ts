import { createRouter } from './router';
import type { Env } from './env';
import { poolTarget } from './families/registry';
import { poolStub } from './do/pool';

// Re-export every Durable Object class so wrangler can wire up bindings.
export { AgentLab } from './families/agent-lab';
export { GatewayLab } from './families/gateway-lab';
export { Pool } from './do/pool';
export { Session } from './do/session';

const app = createRouter();

export default {
  fetch: app.fetch,

  /** Safety-net pool kick, every 5 minutes: ensures each family's Pool DO has its config initialized and its alarm loop running, even if it was never primed via the API. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const family of ['agent', 'gateway'] as const) {
      const stub = poolStub(env, family);
      ctx.waitUntil(stub.initConfig(family, poolTarget(env, family)).then(() => stub.prime()));
    }
  },
};
