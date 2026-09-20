import type { AgentConfig, GatewayConfig } from '../types';
import { CRON_TOOLS } from '../cron/tool-schemas';
import { OrchestrationError } from './types';
import { TaskFiles } from './task-files';

/** Cron credentials stay on the host; every operation is bound to a live worker's agent. */
export function workerCrons(files: TaskFiles, agent: AgentConfig, gateway: GatewayConfig, request: typeof fetch = fetch) {
  return async (attemptId: string, generation: number, tool: string, args: Record<string, unknown>) => {
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
      const response = await request(`${base}/api/v1/crons${path}`, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
      const json = response.status === 204 ? {} : await response.json() as Record<string, any>;
      if (!response.ok) throw new OrchestrationError('CRON_API_ERROR', `Cron API returned HTTP ${response.status}: ${String(json.error ?? 'request failed').slice(0, 1000)}`);
      return json;
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
