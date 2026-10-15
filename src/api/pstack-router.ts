import { Router, Request, Response } from 'express';
import type { AgentConfig, ApiKey, ModelConfig } from '../types';
import { canWriteAgent, createApiAuthMiddleware } from './auth';
import { defineRoute } from './route-registry';
import { selectableModels } from '../agent/model-registry';
import { PstackConfigError } from '../pstack/config';
import { updatePstackConfig } from '../pstack/setup';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Per-agent pstack setup (`agents[].pstack`). pstack itself is installed through
 * Claude Code (`/plugin install pstack@pstack-claude`); these routes only decide
 * which agents' workers load it, and with which models per role.
 *
 *   PUT    /v1/agents/:agentId/pstack  — pstack enable   — Set up pstack for the agent
 *   DELETE /v1/agents/:agentId/pstack  — pstack disable  — Remove it; workers stop loading pstack
 *
 * An admin key may change any agent; a write key, the agents it can access.
 */
export function createPstackRouter(apiKeys: ApiKey[], agentConfigs: Map<string, AgentConfig> | (() => Map<string, AgentConfig>),
  configPath: string | undefined, models: () => ModelConfig[] | undefined): Router {
  const router = Router();
  if (apiKeys) router.use(createApiAuthMiddleware(apiKeys));
  const agents = () => typeof agentConfigs === 'function' ? agentConfigs() : agentConfigs;

  /** `update` gets the saved block and returns the new one, or undefined to remove it. */
  async function save(req: Request, res: Response, update: (previous: AgentConfig['pstack']) => AgentConfig['pstack']): Promise<void> {
    const { agentId } = req.params as { agentId: string };
    if (!canWriteAgent((req as AuthedRequest).apiKey, agentId)) { res.status(403).json({ error: 'Write permission required' }); return; }
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }
    const agent = agents().get(agentId);
    if (!agent) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    try {
      const { saved } = await updatePstackConfig(configPath, agentId, update, await selectableModels(models()));
      // Workers read the live agent config at start; config reload also applies it.
      if (saved) agent.pstack = saved; else delete agent.pstack;
      res.json({ agentId, pstack: saved ?? null });
    } catch (error) {
      if (error instanceof PstackConfigError) { res.status(400).json({ error: error.message, code: error.code }); return; }
      if ((error as { code?: string }).code === 'AGENT_NOT_FOUND') { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
      console.error(`[api] pstack save failed for agent '${agentId}':`, (error as Error).message);
      res.status(500).json({ error: 'Failed to save pstack configuration' });
    }
  }

  defineRoute(router, {
    method: 'PUT', path: '/v1/agents/:agentId/pstack', auth: 'key',
    summary: 'Set up pstack for an agent: its workers load the pstack Claude Code plugin with these role models (full model IDs)',
    cli: { noun: 'pstack', verb: 'enable', args: ['agentId'], flags: [
      { name: 'roles', in: 'body', description: 'JSON map of pstack role -> "<model-id>[ @<level>]" (comma-separated for panel roles); replaces the saved roles, {} resets them. Omitted: unchanged' },
      { name: 'defaultEffort', in: 'body', description: 'session | low | medium | high | xhigh | max. Omitted: unchanged' },
    ] },
  }, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let roles = body.roles;
    if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch { res.status(400).json({ error: 'roles must be a JSON object', code: 'INVALID_PSTACK_CONFIG' }); return; } }
    // A field left out keeps its saved value, so `pstack enable` on an agent already set up changes nothing;
    // `roles: {}` resets every role to the skill default.
    void save(req, res, previous => ({ ...previous, ...body, ...(roles !== undefined ? { roles } : {}) } as AgentConfig['pstack']));
  });

  defineRoute(router, {
    method: 'DELETE', path: '/v1/agents/:agentId/pstack', auth: 'key',
    summary: 'Remove pstack from an agent; its workers stop loading the plugin',
    cli: { noun: 'pstack', verb: 'disable', args: ['agentId'] },
  }, (req, res) => { void save(req, res, () => undefined); });

  return router;
}
