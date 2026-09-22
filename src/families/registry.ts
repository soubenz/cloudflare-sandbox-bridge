import type { Env, Family } from '../env';
import type { AgentLab } from './agent-lab';
import type { GatewayLab } from './gateway-lab';

export interface FamilyConfig {
  family: Family;
  /** Key into Env for this family's Sandbox Durable Object binding. */
  sandboxBinding: 'AGENT_LAB' | 'GATEWAY_LAB';
  /** Key into Env for the pool var that sets this family's warm-pool target. */
  poolTargetVar: 'POOL_TARGET_AGENT' | 'POOL_TARGET_GATEWAY';
  instanceType: 'basic' | 'standard-1' | 'standard-2' | 'standard-3';
}

export const FAMILIES: Record<Family, FamilyConfig> = {
  agent: {
    family: 'agent',
    sandboxBinding: 'AGENT_LAB',
    poolTargetVar: 'POOL_TARGET_AGENT',
    instanceType: 'standard-1',
  },
  gateway: {
    family: 'gateway',
    sandboxBinding: 'GATEWAY_LAB',
    poolTargetVar: 'POOL_TARGET_GATEWAY',
    instanceType: 'standard-1',
  },
};

export function isFamily(value: string): value is Family {
  return value === 'agent' || value === 'gateway';
}

export function sandboxNamespace(env: Env, family: Family): DurableObjectNamespace<AgentLab> | DurableObjectNamespace<GatewayLab> {
  return env[FAMILIES[family].sandboxBinding];
}

export function poolTarget(env: Env, family: Family): number {
  const raw = env[FAMILIES[family].poolTargetVar];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
