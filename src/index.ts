import { createRouter } from './router';
import type { Env } from './env';
import { poolTarget } from './families/registry';
import { poolStub } from './do/pool';

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
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const family of ['agent', 'gateway'] as const) {
      const stub = poolStub(env, family);
      ctx.waitUntil(stub.initConfig(family, poolTarget(env, family)).then(() => stub.prime()));
    }
  },
};
