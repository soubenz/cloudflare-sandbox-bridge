import { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../env';
import { LLM_HOST, MIRROR_HOST, BUNDLES_HOST, llmOutbound, mirrorOutbound, bundlesOutbound } from './egress';

/**
 * Container class for the "agent" lab family (Python agent + LiteLLM +
 * Grafana). One Sandbox subclass per family, each with its own Dockerfile
 * (images/agent/Dockerfile) and its own warm pool — see families/registry.ts.
 *
 * Egress is closed by default (`enableInternet = false`); only the LLM
 * Worker, the package mirror, and the lab-bundle server are reachable, and
 * only the LLM Worker call gets a credential (injected here, never seen by
 * the container). Per-lab extra hosts are added at session start via
 * `setAllowedHosts()` from `manifest.egress.allow[]` — see
 * session/lifecycle.ts.
 */
export class AgentLab extends Sandbox<Env> {
  static enableInternet = false;
  static allowedHosts = [LLM_HOST, MIRROR_HOST, BUNDLES_HOST];
  static outboundByHost = {
    [LLM_HOST]: llmOutbound,
    [MIRROR_HOST]: mirrorOutbound,
    [BUNDLES_HOST]: bundlesOutbound,
  };
}
