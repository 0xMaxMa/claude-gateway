import { promises as fsp } from 'fs';
import { withConfigWriteLock, writeConfigAtomic } from '../config/config-write-lock';
import type { ModelConfig } from '../types';
import { AgentPstackConfig, validatePstack } from './config';
import { pstackModels, pstackPluginInfo } from './plugin-info';

/**
 * Set up (or with `undefined`, remove) pstack for one agent: validate against
 * the live models and the installed plugin, then write `agents[].pstack`.
 * Shared by /pstack-setup, the API and the CLI so all three apply the same
 * rules. Returns the saved block (models written as canonical IDs).
 */
export async function savePstackConfig(configPath: string, agentId: string, block: AgentPstackConfig | undefined, models: ModelConfig[]): Promise<AgentPstackConfig | undefined> {
  return (await updatePstackConfig(configPath, agentId, () => block, models)).saved;
}

/**
 * Change pstack from the block saved in config.json, read under the config
 * write lock, so an edit (a sheet line, a menu button) applies to the latest
 * block and never drops one saved meanwhile from another surface. `update`
 * returns the new block, `undefined` to remove it, or `previous` to leave it.
 */
export async function updatePstackConfig(configPath: string, agentId: string, update: (previous: AgentPstackConfig | undefined) => AgentPstackConfig | undefined, models: ModelConfig[]): Promise<{ previous: AgentPstackConfig | undefined; saved: AgentPstackConfig | undefined }> {
  return withConfigWriteLock(configPath, async () => {
    const config = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> };
    const agent = config.agents?.find(a => a.id === agentId);
    if (!agent) throw Object.assign(new Error(`Agent '${agentId}' not found in config`), { code: 'AGENT_NOT_FOUND' });
    const previous = agent.pstack as AgentPstackConfig | undefined;
    const block = update(previous);
    if (block === previous) return { previous, saved: previous };
    let saved: AgentPstackConfig | undefined;
    if (block) {
      const plugin = pstackPluginInfo();
      saved = validatePstack(agentId, block, models, plugin.installPath ? pstackModels(plugin.installPath) : undefined);
    }
    if (saved) agent.pstack = saved; else delete agent.pstack;
    await writeConfigAtomic(configPath, config);
    return { previous, saved };
  });
}
