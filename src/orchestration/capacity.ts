import type { GatewayConfig } from '../types';
import type { SessionRole } from './types';
import { OrchestrationError } from './types';

export class ProcessCapacity {
  private readonly active = new Map<symbol, SessionRole>();
  constructor(readonly total: number, readonly reservedAgent: number) {
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(reservedAgent) || reservedAgent < 1 || total <= reservedAgent) throw new OrchestrationError('INVALID_PROCESS_LIMITS');
  }
  acquire(role: SessionRole, enforce = true): (() => void) | undefined {
    if (enforce && this.active.size >= this.total) return undefined;
    if (enforce && role !== 'agent' && [...this.active.values()].filter(value => value !== 'agent').length >= this.total - this.reservedAgent) return undefined;
    const key = Symbol(role); this.active.set(key, role);
    return () => { this.active.delete(key); };
  }
  get count(): number { return this.active.size; }
}
const capacities = new WeakMap<GatewayConfig, ProcessCapacity>();
export function gatewayCapacity(config: GatewayConfig): ProcessCapacity {
  let capacity = capacities.get(config);
  if (!capacity) {
    capacity = new ProcessCapacity(config.gateway.processLimits?.maxTotal ?? 32, config.gateway.processLimits?.reservedAgent ?? 2);
    capacities.set(config, capacity);
  }
  return capacity;
}
