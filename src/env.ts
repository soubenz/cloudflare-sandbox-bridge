import type { AgentLab } from './families/agent-lab';
import type { GatewayLab } from './families/gateway-lab';
import type { Pool } from './do/pool';
import type { Session } from './do/session';

/** Lab family names. Every lab manifest names one of these. */
export type Family = 'agent' | 'gateway';

export interface Env {
  // Durable Object bindings.
  AGENT_LAB: DurableObjectNamespace<AgentLab>;
  GATEWAY_LAB: DurableObjectNamespace<GatewayLab>;
  POOL: DurableObjectNamespace<Pool>;
  SESSION: DurableObjectNamespace<Session>;

  // Storage bindings.
  BACKUP_BUCKET: R2Bucket;
  LABS_BUCKET: R2Bucket;
  DB: D1Database;

  // Vars.
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  LOCATION_HINT: string;
  PUBLIC_BASE_URL: string;
  POOL_TARGET_AGENT: string;
  POOL_TARGET_GATEWAY: string;
  LLM_HOST: string;
  MIRROR_HOST: string;

  // Secrets.
  SANDBOX_API_KEY: string;
  SESSION_TOKEN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  LLM_WORKER_KEY: string;
}
