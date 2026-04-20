import { EventEmitter } from 'events';
import { loadConfig } from './loader';
import { AgentConfig, GatewayConfig, Logger } from '../types';
import { createWatcher, WatchHandle } from '../watch/factory';

// Fields that can be hot-reloaded without restarting the gateway
const HOT_RELOADABLE_AGENT_FIELDS: string[] = [
  'claude.model',
  'claude.extraFlags',
  'claude.dangerouslySkipPermissions',
  'session.idleTimeoutMinutes',
  'session.maxConcurrent',
  'heartbeat.rateLimitMinutes',
];

export interface ConfigChange {
  agentId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  hotReloadable: boolean;
}

interface DiffResult {
  fieldChanges: ConfigChange[];
  addedAgents: AgentConfig[];
}

export class ConfigWatcher extends EventEmitter {
  on(event: 'changes', listener: (changes: ConfigChange[], newCfg: GatewayConfig, oldCfg: GatewayConfig) => void): this;
  on(event: 'agent.added', listener: (agent: AgentConfig) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private watchHandle: WatchHandle | null = null;
  private currentConfig: GatewayConfig;

  constructor(
    private readonly configPath: string,
    initialConfig: GatewayConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.currentConfig = structuredClone(initialConfig);
  }

  start(): void {
    this.watchHandle = createWatcher({
      paths: [this.configPath],
      debounceMs: 500,
      chokidarOpts: { awaitWriteFinish: { stabilityThreshold: 300 } },
      onChange: () => this.reload(),
    });
  }

  stop(): void {
    void this.watchHandle?.close();
    this.watchHandle = null;
  }

  /** Get current config snapshot */
  getConfig(): GatewayConfig {
    return this.currentConfig;
  }

  reload(): void {
    let newConfig: GatewayConfig;
    try {
      newConfig = loadConfig(this.configPath);
    } catch (err) {
      this.logger.error('Config reload failed, keeping current config', {
        error: (err as Error).message,
      });
      return;
    }

    const { fieldChanges, addedAgents } = this.diffConfig(this.currentConfig, newConfig);

    if (fieldChanges.length === 0 && addedAgents.length === 0) {
      this.logger.info('Config file changed but no effective differences detected');
      return;
    }

    // Always update currentConfig when there are any changes (including new agents)
    const oldConfig = this.currentConfig;
    this.currentConfig = structuredClone(newConfig);

    // Emit field changes for existing agents
    if (fieldChanges.length > 0) {
      const hotChanges = fieldChanges.filter(c => c.hotReloadable);
      const coldChanges = fieldChanges.filter(c => !c.hotReloadable);

      if (hotChanges.length > 0) {
        this.logger.info('Config hot-reloaded', {
          fields: hotChanges.map(c => `${c.agentId}.${c.field}`),
        });
      }
      if (coldChanges.length > 0) {
        this.logger.warn('Config changes require restart to take effect', {
          fields: coldChanges.map(c => `${c.agentId}.${c.field}`),
        });
      }

      this.emit('changes', fieldChanges, newConfig, oldConfig);
    }

    // Emit agent.added for each new agent
    for (const agent of addedAgents) {
      this.logger.info('New agent detected in config', { id: agent.id });
      this.emit('agent.added', agent);
    }
  }

  private diffConfig(oldCfg: GatewayConfig, newCfg: GatewayConfig): DiffResult {
    const fieldChanges: ConfigChange[] = [];
    const addedAgents: AgentConfig[] = [];

    // Build agent maps by id for comparison
    const oldAgents = new Map<string, AgentConfig>();
    for (const agent of oldCfg.agents) {
      oldAgents.set(agent.id, agent);
    }

    const newAgents = new Map<string, AgentConfig>();
    for (const agent of newCfg.agents) {
      newAgents.set(agent.id, agent);
    }

    // Compare agents that exist in both configs; collect new agents separately
    for (const [id, newAgent] of newAgents) {
      const oldAgent = oldAgents.get(id);
      if (!oldAgent) {
        addedAgents.push(newAgent);
        continue;
      }

      // Check each field path
      const fieldPairs: Array<{ field: string; oldVal: unknown; newVal: unknown }> = [
        { field: 'claude.model', oldVal: oldAgent.claude.model, newVal: newAgent.claude.model },
        { field: 'claude.extraFlags', oldVal: oldAgent.claude.extraFlags, newVal: newAgent.claude.extraFlags },
        { field: 'claude.dangerouslySkipPermissions', oldVal: oldAgent.claude.dangerouslySkipPermissions, newVal: newAgent.claude.dangerouslySkipPermissions },
        { field: 'session.idleTimeoutMinutes', oldVal: oldAgent.session?.idleTimeoutMinutes, newVal: newAgent.session?.idleTimeoutMinutes },
        { field: 'session.maxConcurrent', oldVal: oldAgent.session?.maxConcurrent, newVal: newAgent.session?.maxConcurrent },
        { field: 'heartbeat.rateLimitMinutes', oldVal: oldAgent.heartbeat?.rateLimitMinutes, newVal: newAgent.heartbeat?.rateLimitMinutes },
        { field: 'workspace', oldVal: oldAgent.workspace, newVal: newAgent.workspace },
        { field: 'telegram.botToken', oldVal: oldAgent.telegram?.botToken, newVal: newAgent.telegram?.botToken },
        { field: 'telegram.allowedUsers', oldVal: oldAgent.telegram?.allowedUsers, newVal: newAgent.telegram?.allowedUsers },
        { field: 'telegram.dmPolicy', oldVal: oldAgent.telegram?.dmPolicy, newVal: newAgent.telegram?.dmPolicy },
        { field: 'description', oldVal: oldAgent.description, newVal: newAgent.description },
      ];

      for (const { field, oldVal, newVal } of fieldPairs) {
        if (!deepEqual(oldVal, newVal)) {
          fieldChanges.push({
            agentId: id,
            field,
            oldValue: oldVal,
            newValue: newVal,
            hotReloadable: HOT_RELOADABLE_AGENT_FIELDS.includes(field),
          });
        }
      }
    }

    return { fieldChanges, addedAgents };
  }
}

/** Simple deep equality check for primitives, arrays, and plain objects */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

// Export for testing
export { deepEqual as _deepEqual, HOT_RELOADABLE_AGENT_FIELDS };
