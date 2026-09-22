import { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../env';
import { LLM_HOST, MIRROR_HOST, BUNDLES_HOST, llmOutbound, mirrorOutbound, bundlesOutbound } from './egress';

/**
 * Container class for the "gateway" lab family (LiteLLM + Grafana +
 * Prometheus + a load-generation tool). Same egress policy as AgentLab;
 * kept as a separate class so its image and warm pool are independent
 * (build gateway image without touching agent labs, scale them separately).
 */
export class GatewayLab extends Sandbox<Env> {
  static enableInternet = false;
  static allowedHosts = [LLM_HOST, MIRROR_HOST, BUNDLES_HOST];
  static outboundByHost = {
    [LLM_HOST]: llmOutbound,
    [MIRROR_HOST]: mirrorOutbound,
    [BUNDLES_HOST]: bundlesOutbound,
  };
}
