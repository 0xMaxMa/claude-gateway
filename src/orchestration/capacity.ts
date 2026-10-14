import type { GatewayConfig } from '../types';
import type { SessionRole } from './types';
import { OrchestrationError } from './types';

export class ProcessCapacity {
  private readonly active = new Map<symbol, SessionRole>();
  private readonly workers = new Map<string, () => void>();
  constructor(public total: number, public reservedAgent: number) {
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(reservedAgent) || reservedAgent < 1 || total <= reservedAgent) throw new OrchestrationError('INVALID_PROCESS_LIMITS');
  }
  configure(total:number,reservedAgent:number):void {
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(reservedAgent)||reservedAgent<1||total<=reservedAgent)throw new OrchestrationError('INVALID_PROCESS_LIMITS');
    this.total=total;this.reservedAgent=reservedAgent;
  }
  /** `allowance` lets the process exceed the limits by that many slots (see acquireWorker). */
  acquire(role: SessionRole, enforce = true, allowance = 0): (() => void) | undefined {
    if (enforce && this.active.size >= this.total + allowance) return undefined;
    if (enforce && role !== 'agent' && [...this.active.values()].filter(value => value !== 'agent').length >= this.total - this.reservedAgent + allowance) return undefined;
    const key = Symbol(role); this.active.set(key, role);
    return () => { this.active.delete(key); };
  }
  /**
   * A subagent's ancestors hold their slots while they wait for it. As in TaskService.claim, those
   * slots are not counted against it, so a chain can always extend while siblings still queue.
   */
  acquireWorker(agentId: string, taskId: string, enforce = true, ancestorTaskIds: string[] = []): (() => void) | undefined {
    const key = JSON.stringify([agentId, taskId]);
    const existing = this.workers.get(key);
    if (existing) return existing;
    const holding = ancestorTaskIds.filter(id => this.workers.has(JSON.stringify([agentId, id]))).length;
    const releaseSlot = this.acquire('worker', enforce, holding);
    if (!releaseSlot) return undefined;
    const release = () => {
      releaseSlot();
      if (this.workers.get(key) === release) this.workers.delete(key);
    };
    this.workers.set(key, release);
    return release;
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
  capacity.configure(config.gateway.processLimits?.maxTotal ?? 32,config.gateway.processLimits?.reservedAgent ?? 2);
  return capacity;
}
