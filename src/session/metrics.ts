import type { SessionRuntime } from './state';
import { emitEvent } from './events';

/**
 * standard-1: 0.5 vCPU, 4 GiB, 8 GB disk. Cloudflare bills memory and disk
 * on provisioned size regardless of activity, and vCPU only while active
 * (see the pricing review in the plan). The SDK does not expose per-instance
 * CPU/memory utilization today, so this counter assumes CPU is active the
 * whole time a session is running — a conservative (upper-bound) estimate
 * for the live cost counter the product plan calls for, not a billing
 * reconciliation. When the Cloudflare dashboard/API exposes real per-instance
 * utilization, replace RATE_PER_SECOND_USD below with an actual read.
 */
const VCPU = 0.5;
const MEMORY_GIB = 4;
const DISK_GB = 8;
const VCPU_SECOND_USD = 0.00002;
const MEMORY_GIB_SECOND_USD = 0.0000025;
const DISK_GB_SECOND_USD = 0.00000007;
const RATE_PER_SECOND_USD = VCPU * VCPU_SECOND_USD + MEMORY_GIB * MEMORY_GIB_SECOND_USD + DISK_GB * DISK_GB_SECOND_USD;

/** Called by the metrics alarm (every 30s while running). Updates the running cost estimate and emits it. */
export async function tickMetrics(rt: SessionRuntime): Promise<void> {
  const meta = await rt.requireMeta();
  if (!meta.started_at) return;
  const cost = await rt.cost();
  const running_s = Math.floor((Date.now() - meta.started_at) / 1000);
  const usd = running_s * RATE_PER_SECOND_USD;
  const next = { ...cost, running_s, usd };
  await rt.putCost(next);
  emitEvent(rt, 'metrics', { running_s, cost_usd: Number(usd.toFixed(4)), llm_cost_usd: Number(cost.llm_usd.toFixed(4)) });
}

/** Called by POST /sessions/{id}/events when the LLM Worker reports spend for a call. */
export async function recordLlmCost(rt: SessionRuntime, deltaUsd: number): Promise<void> {
  const cost = await rt.cost();
  await rt.putCost({ ...cost, llm_usd: cost.llm_usd + deltaUsd });
}
