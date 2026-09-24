import { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../env';
import { BASE_ALLOWED_HOSTS, LLM_HOST, MIRROR_HOST, BUNDLES_HOST, llmOutbound, mirrorOutbound, bundlesOutbound } from './egress';

/**
 * Container class for the "gateway" lab family (LiteLLM + Grafana +
 * Prometheus + a load-generation tool). Same egress policy as AgentLab;
 * kept as a separate class so its image and warm pool are independent
 * (build gateway image without touching agent labs, scale them separately).
 */
export class GatewayLab extends Sandbox<Env> {
  // INSTANCE fields, deliberately not `static`. The base class reads
  // `this.enableInternet` and `this.allowedHosts` (see
  // Container#effectiveAllowedHosts); a `static` declaration is silently
  // ignored, so declaring these static left `enableInternet` at its
  // default of `true` and `allowedHosts` undefined — the container had
  // unrestricted internet access and nothing reached the outbound
  // handlers. `outboundByHost` below is the exception: it really is a
  // static, backed by a registry keyed on the class name.
  enableInternet = false;
  allowedHosts = BASE_ALLOWED_HOSTS;
  // Without this, only plain HTTP passes through the handler chain.
  // images/*/opalix-init.sh installs the Cloudflare CA the container
  // needs to trust for this.
  interceptHttps = true;
  static outboundByHost = {
    [LLM_HOST]: llmOutbound,
    [MIRROR_HOST]: mirrorOutbound,
    [BUNDLES_HOST]: bundlesOutbound,
  };
}
