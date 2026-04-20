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

export class ConfigWatcher extends EventEmitter {
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

    const changes = this.diffConfig(this.currentConfig, newConfig);
    if (changes.length === 0) {
      this.logger.info('Config file changed but no effective differences detected');
      return;
    }

    const oldConfig = this.currentConfig;
    this.currentConfig = structuredClone(newConfig);

    const hotChanges = changes.filter(c => c.hotReloadable);
    const coldChanges = changes.filter(c => !c.hotReloadable);

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

    this.emit('changes', changes, newConfig, oldConfig);
  }

  private diffConfig(oldCfg: GatewayConfig, newCfg: GatewayConfig): ConfigChange[] {
    const changes: ConfigChange[] = [];

    // Build agent maps by id for comparison
    const oldAgents = new Map<string, AgentConfig>();
    for (const agent of oldCfg.agents) {
      oldAgents.set(agent.id, agent);
    }

    const newAgents = new Map<string, AgentConfig>();
    for (const agent of newCfg.agents) {
      newAgents.set(agent.id, agent);
    }

    // Compare agents that exist in both configs
    for (const [id, newAgent] of newAgents) {
      const oldAgent = oldAgents.get(id);
      if (!oldAgent) continue; // new agent added — not hot-reloadable

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
          changes.push({
            agentId: id,
            field,
            oldValue: oldVal,
            newValue: newVal,
            hotReloadable: HOT_RELOADABLE_AGENT_FIELDS.includes(field),
          });
        }
      }
    }

    return changes;
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
