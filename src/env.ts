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
  /** Optional time-of-day override of POOL_TARGET_AGENT, UTC, e.g. "mon-fri 06-20=1; *=0". See src/lib/pool-schedule.ts. */
  POOL_SCHEDULE_AGENT?: string;
  POOL_SCHEDULE_GATEWAY?: string;
  /** Optional per-hour price in USD (string number) used by GET /usage; defaults 0.074 agent, 0.148 gateway. */
  PRICE_PER_HOUR_AGENT?: string;
  PRICE_PER_HOUR_GATEWAY?: string;
  LLM_HOST: string;
  /** AI Gateway name on the account; with LLM_HOST and the account id it forms the compat endpoint. */
  AI_GATEWAY_NAME: string;
  /** Default model for labs, e.g. workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8. */
  LLM_MODEL: string;
  MIRROR_HOST: string;
  /** Comma-separated origins allowed to call this API from a browser. The dashboard is its own Worker, so it is cross-origin. */
  DASHBOARD_ORIGIN: string;

  // Secrets.
  SANDBOX_API_KEY: string;
  /** Optional. The retiring service key, accepted alongside SANDBOX_API_KEY during a rotation window. Unset outside one. */
  SANDBOX_API_KEY_PREVIOUS?: string;
  SESSION_TOKEN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Cloudflare API token with Workers AI access; injected into model calls by llmOutbound. */
  AI_GATEWAY_TOKEN: string;
  /** Optional. Slack- or Discord-compatible webhook URL that receives pool degraded/recovered alerts. */
  ALERT_WEBHOOK_URL?: string;
}
