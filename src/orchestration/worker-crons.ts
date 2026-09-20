import type { AgentConfig, GatewayConfig } from '../types';
import { CRON_TOOLS } from '../cron/tool-schemas';
import { OrchestrationError } from './types';
import { TaskFiles } from './task-files';

/** Cron credentials stay on the host; every operation is bound to a live worker's agent. */
export function workerCrons(files: TaskFiles, agent: AgentConfig, gateway: GatewayConfig, request: typeof fetch = fetch) {
  return async (attemptId: string, generation: number, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const validate = () => {
      const { task } = files.scope(attemptId, generation);
      if (!task.capabilities.execute || task.agentId !== agent.id) throw new OrchestrationError('CRON_SCOPE_DENIED');
    };
    validate();
    const definition = CRON_TOOLS.find(t => t.name === tool);
    if (!definition || Object.keys(args).some(k => !Object.prototype.hasOwnProperty.call(definition.inputSchema.properties, k))) throw new OrchestrationError('INVALID_INPUT');
    const key = gateway.gateway.api?.keys?.find(k => k.agents === '*' || Array.isArray(k.agents) && k.agents.includes(agent.id))?.key;
    if (!key) throw new OrchestrationError('CRON_NOT_CONFIGURED');
    const base = (process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`).replace(/\/+$/, '');
    const call = async (path: string, method = 'GET', body?: Record<string, unknown>) => {
      validate();
      if (signal?.aborted) throw new OrchestrationError('CRON_API_ERROR', 'Cron request cancelled before dispatch.');
      // The manual-run endpoint waits for the job AND its delegated workers.
      // Keep short deadlines for CRUD; a run waits until completion or caller
      // cancellation. Cancelling the HTTP wait does not cancel the cron job.
      const deadline = method === 'POST' && path.endsWith('/run') ? undefined : AbortSignal.timeout(15000);
      const signals = [signal, deadline].filter((s): s is AbortSignal => s !== undefined);
      try {
        const response = await request(`${base}/api/v1/crons${path}`, {
          method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: signals.length ? AbortSignal.any(signals) : undefined,
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({})) as Record<string, unknown>;
          throw new OrchestrationError('CRON_API_ERROR', `Cron API returned HTTP ${response.status}: ${String(error.error ?? 'request failed').slice(0, 1000)}`);
        }
        return response.status === 204 ? {} : await response.json() as Record<string, any>;
      } catch (error) {
        if (error instanceof OrchestrationError) throw error;
        if (method !== 'GET') throw new OrchestrationError('CRON_OUTCOME_UNKNOWN',
          'The cron request was dispatched but its outcome could not be confirmed. The job or change may still complete. Do not retry the mutation blindly; inspect cron_list and cron_get_runs first.');
        throw new OrchestrationError('CRON_API_ERROR', 'Cron lookup interrupted or returned an invalid response. No mutation was dispatched by this lookup.');
      }
    };
    const container = agent.type === 'app-agent';
    if (tool === 'cron_list') {
      const result = await call(`?agent=${encodeURIComponent(agent.id)}`);
      return { jobs: (Array.isArray(result.jobs) ? result.jobs : []).filter((job: any) => job.agentId === agent.id && (!container || job.type === 'agent')) };
    }
    if (container && (args.command !== undefined || args.type !== undefined && args.type !== 'agent' || tool === 'cron_run')) throw new OrchestrationError('CRON_SCOPE_DENIED');
    if (tool === 'cron_create') {
      if (container && args.type !== 'agent') throw new OrchestrationError('CRON_SCOPE_DENIED');
      const { timeout_ms, ...body } = args;
      return call('', 'POST', { ...body, agentId: agent.id, ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
        deleteAfterRun: args.deleteAfterRun ?? args.scheduleKind === 'at' });
    }
    if (typeof args.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.job_id)) throw new OrchestrationError('INVALID_INPUT');
    const path = `/${args.job_id}`;
    const { job } = await call(path);
    if (!job || job.agentId !== agent.id || container && job.type !== 'agent') throw new OrchestrationError('CRON_SCOPE_DENIED');
    if (tool === 'cron_update') {
      const { job_id: _id, timeout_ms, ...body } = args;
      return call(path, 'PUT', { ...body, ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }) });
    }
    if (tool === 'cron_delete') return call(path, 'DELETE');
    if (tool === 'cron_run') return call(`${path}/run`, 'POST');
    if (tool === 'cron_get_runs') return call(`${path}/runs`);
    throw new OrchestrationError('TOOL_DENIED');
  };
}
