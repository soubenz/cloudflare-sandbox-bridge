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
  // handlers.
  enableInternet = false;
  allowedHosts = BASE_ALLOWED_HOSTS;
  // Without this, only plain HTTP passes through the handler chain.
  // images/*/opalix-init.sh installs the Cloudflare CA the container
  // needs to trust for this.
  interceptHttps = true;
}

// Assigned, not declared as a `static` class field. Under ES2022 class-field
// semantics (target: ES2022 implies useDefineForClassFields) a static field
// is installed with Object.defineProperty, which SHADOWS Container's
// inherited `static set outboundByHost` rather than calling it — so the
// handler registry that setter populates stayed empty, ContainerProxy found
// no handler for these hosts, and every request fell through to a direct
// internet fetch. An assignment statement goes through the setter.
GatewayLab.outboundByHost = {
  [LLM_HOST]: llmOutbound,
  [MIRROR_HOST]: mirrorOutbound,
  [BUNDLES_HOST]: bundlesOutbound,
};
