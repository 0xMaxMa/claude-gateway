import { AgentConfig, GatewayConfig } from '../types';
import { OrchestrationError } from './types';
import { TaskFiles } from './task-files';
import { ingestOrchestrationMedia } from './media';

/** Forward only media operations for the captured agent; keep API keys in the gateway. */
export function workerShares(files: TaskFiles, agent: AgentConfig, gateway: GatewayConfig, request: typeof fetch = fetch) {
  const minted = new Map<string, string>();
  return async (attemptId: string, generation: number, args: Record<string, unknown>) => {
    const { task } = files.scope(attemptId, generation);
    const method = args.method, pathname = args.pathname;
    if (typeof pathname !== 'string' || pathname.length > 4096) throw new OrchestrationError('SHARE_SCOPE_DENIED');
    const key = gateway.gateway.api?.keys?.find(k => k.agents === '*' || k.admin || (Array.isArray(k.agents) && k.agents.includes(agent.id)))?.key;
    if (!key) throw new OrchestrationError('SHARE_NOT_CONFIGURED');
    const body: Record<string, unknown> = { ...(args.body as Record<string, unknown> ?? {}), agent_id: agent.id, session_id: task.agentSessionId };
    let target: string;
    if (method === 'GET' && pathname.startsWith('/api/v1/image-catalog?')) {
      target = `/api/v1/image-catalog?agent_id=${encodeURIComponent(agent.id)}&session_id=${encodeURIComponent(task.agentSessionId)}`;
    } else if (method === 'POST' && pathname === '/api/v1/shares') {
      if (!Array.isArray(body.refs) || !body.refs.length || body.refs.length > 5) throw new OrchestrationError('INVALID_INPUT');
      body.refs = body.refs.map(ref => {
        if (ref && typeof ref.artifact_id === 'string' && !ref.path) return { artifact_id: ref.artifact_id };
        if (!ref || ref.artifact_id) throw new OrchestrationError('SHARE_SCOPE_DENIED');
        return { path: ingestOrchestrationMedia(files.agentsRoot, agent.id, `api-${task.agentSessionId}`, files.allowedPath(attemptId, generation, ref.path)) };
      });
      target = pathname;
    } else if (method === 'POST' && pathname === '/api/v1/image-artifacts') {
      if (!Array.isArray(body.files) || !body.files.length || body.files.length > 10) throw new OrchestrationError('INVALID_INPUT');
      body.files = body.files.map(path => ingestOrchestrationMedia(files.agentsRoot, agent.id, `api-${task.agentSessionId}`, files.allowedPath(attemptId, generation, path)));
      target = pathname;
    } else if (method === 'DELETE' && /^\/api\/v1\/shares\/[A-Za-z0-9_-]+$/.test(pathname) && minted.get(pathname.split('/').at(-1)!) === task.taskId) target = pathname;
    else throw new OrchestrationError('SHARE_SCOPE_DENIED');
    const base = (process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`).replace(/\/+$/, '');
    const response = await request(`${base}${target}`, { method: String(method), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const json = await response.json() as Record<string, unknown>;
    if (target === '/api/v1/shares' && response.status === 201 && Array.isArray(json.items)) for (const item of json.items) {
      minted.set(item.share_id, task.taskId);
      if (minted.size > 10000) minted.delete(minted.keys().next().value!);
    }
    if (method === 'DELETE' && response.ok) minted.delete(target.split('/').at(-1)!);
    return { status: response.status, json };
  };
}
