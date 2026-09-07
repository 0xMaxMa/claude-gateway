import { EventEmitter } from 'events';
import { loadConfig, logSkippedAgents, SkippedAgent } from './loader';
import { agentsDirForConfig, loadAgentEnvFiles } from './agent-env';
import { AgentConfig, GatewayConfig, Logger } from '../types';
import { createWatcher, WatchHandle } from '../watch/factory';
import { expandHome } from '../utils/paths';

// Fields that can be hot-reloaded without restarting the gateway
const HOT_RELOADABLE_AGENT_FIELDS: string[] = [
  'claude.model',
  'claude.extraFlags',
  'session.idleTimeoutMinutes',
  'session.maxConcurrent',
  'heartbeat.rateLimitMinutes',
  // Per-agent connector enablement ({connectorId: {enabled}}) — only affects
  // NEW session spawns (SessionProcess reads it fresh via AgentRunner's own
  // live object reference, see index.ts's 'changes' handler); an
  // already-running session's subprocess still needs an explicit restart
  // (restartSessionsUsingConnector) to pick it up mid-conversation.
  'connectors',
];

// Gateway-level (non-agent) fields that can be hot-reloaded; agentId will be '' in ConfigChange
const HOT_RELOADABLE_GATEWAY_FIELDS: string[] = [
  'gateway.headless',
  // Logging policy is process-wide module state, so re-installing it is just a
  // call — and turning the level up to chase a live problem is precisely when a
  // restart is unaffordable, since it kills the sessions being investigated.
  'gateway.logs',
  // Same "new spawns only" caveat as 'connectors' above — customConnectors is
  // where every connector definition lives regardless of who owns its
  // credential (see connectors/types.ts's CustomConnectorEntry).
  'gateway.customConnectors',
  // The default the per-agent `connectors` map is read against
  // (resolveEnabledConnectors' third argument). Hot-reloadable for the same
  // reason and with the same scope as the two above: both readers —
  // SessionProcess.writeMcpConfig and AgentRunner.restartSessionsUsingConnector
  // — take it off the live config object at call time, so replacing it here is
  // enough for every subsequent spawn. Flipping it to `false` is how an operator
  // shuts every not-explicitly-enabled connector off on a shared box; making
  // that wait for a gateway restart would mean killing the sessions in order to
  // narrow what they can reach.
  //
  // gateway.oauthReturnUrl is deliberately NOT here: createOauthCallbackRouter
  // captures it as a plain argument at mount time (gateway-router.ts), so a live
  // edit cannot reach the mounted router. It is listed in gatewayFieldPairs
  // below so the change is still reported — as restart-required, like publicUrl.
  'gateway.connectorsDefaultEnabled',
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
  on(event: 'channel.added', listener: (agentId: string, channel: string) => void): this;
  on(event: 'channel.removed', listener: (agentId: string, channel: string) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private watchHandle: WatchHandle | null = null;
  private currentConfig: GatewayConfig;
  private readonly agentsDir: string;

  constructor(
    private readonly configPath: string,
    initialConfig: GatewayConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.currentConfig = structuredClone(initialConfig);
    this.agentsDir = agentsDirForConfig(configPath);
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
    // Fold any per-agent .env files into process.env BEFORE interpolation.
    // An agent added while the gateway is running (MCP `agent_create`) writes
    // its token to a brand-new agents/<id>/.env and only a ${VAR} placeholder
    // into config.json. Without this refresh that variable is absent from
    // process.env, loadConfig() drops the agent, the diff below sees nothing,
    // and `agent.added` — whose handler is what used to load the .env — never
    // fires. Issue #427.
    loadAgentEnvFiles(this.agentsDir);

    let newConfig: GatewayConfig;
    const skipped: SkippedAgent[] = [];
    try {
      newConfig = loadConfig(this.configPath, {
        onSkippedAgent: (s) => skipped.push(s),
      });
      newConfig.gateway.logDir = expandHome(newConfig.gateway.logDir);
    } catch (err) {
      this.logger.error('Config reload failed, keeping current config', {
        error: (err as Error).message,
      });
      return;
    }

    // Report drops before the no-change bail-out below: a silently dropped
    // agent produces exactly zero diff, so this is the only trace it leaves.
    logSkippedAgents(this.logger, skipped, 'Agent skipped during config reload');

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
          fields: hotChanges.map(c => c.agentId ? `${c.agentId}.${c.field}` : c.field),
        });
      }
      if (coldChanges.length > 0) {
        this.logger.warn('Config changes require restart to take effect', {
          fields: coldChanges.map(c => c.agentId ? `${c.agentId}.${c.field}` : c.field),
        });
      }

      this.emit('changes', fieldChanges, newConfig, oldConfig);

      // Emit channel.added / channel.removed when tokens change on existing agents
      for (const change of fieldChanges) {
        const added = !change.oldValue && change.newValue;
        const removed = change.oldValue && !change.newValue;
        // Token replaced (revoke + recreate): stop old receiver, start new one
        const replaced = change.oldValue && change.newValue && change.oldValue !== change.newValue;

        if (added || replaced) {
          if (change.field === 'discord.botToken') {
            if (replaced) this.emit('channel.removed', change.agentId, 'discord');
            this.logger.info('Discord channel added to agent', { agentId: change.agentId });
            this.emit('channel.added', change.agentId, 'discord');
          }
          if (change.field === 'telegram.botToken') {
            if (replaced) this.emit('channel.removed', change.agentId, 'telegram');
            this.logger.info('Telegram channel added to agent', { agentId: change.agentId });
            this.emit('channel.added', change.agentId, 'telegram');
          }
        }
        if (removed) {
          if (change.field === 'discord.botToken') {
            this.logger.info('Discord channel removed from agent', { agentId: change.agentId });
            this.emit('channel.removed', change.agentId, 'discord');
          }
          if (change.field === 'telegram.botToken') {
            this.logger.info('Telegram channel removed from agent', { agentId: change.agentId });
            this.emit('channel.removed', change.agentId, 'telegram');
          }
        }
      }
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
        { field: 'session.idleTimeoutMinutes', oldVal: oldAgent.session?.idleTimeoutMinutes, newVal: newAgent.session?.idleTimeoutMinutes },
        { field: 'session.maxConcurrent', oldVal: oldAgent.session?.maxConcurrent, newVal: newAgent.session?.maxConcurrent },
        { field: 'heartbeat.rateLimitMinutes', oldVal: oldAgent.heartbeat?.rateLimitMinutes, newVal: newAgent.heartbeat?.rateLimitMinutes },
        { field: 'workspace', oldVal: oldAgent.workspace, newVal: newAgent.workspace },
        { field: 'telegram.botToken', oldVal: oldAgent.telegram?.botToken, newVal: newAgent.telegram?.botToken },
        { field: 'discord.botToken', oldVal: oldAgent.discord?.botToken, newVal: newAgent.discord?.botToken },
        { field: 'description', oldVal: oldAgent.description, newVal: newAgent.description },
        { field: 'connectors', oldVal: oldAgent.connectors, newVal: newAgent.connectors },
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

    // Gateway-level fields (emitted with agentId: '')
    const gatewayFieldPairs: Array<{ field: string; oldVal: unknown; newVal: unknown }> = [
      { field: 'gateway.headless', oldVal: oldCfg.gateway.headless, newVal: newCfg.gateway.headless },
      { field: 'gateway.publicUrl', oldVal: oldCfg.gateway.publicUrl, newVal: newCfg.gateway.publicUrl },
      { field: 'gateway.logs', oldVal: oldCfg.gateway.logs, newVal: newCfg.gateway.logs },
      { field: 'gateway.customConnectors', oldVal: oldCfg.gateway.customConnectors, newVal: newCfg.gateway.customConnectors },
      { field: 'gateway.connectorsDefaultEnabled', oldVal: oldCfg.gateway.connectorsDefaultEnabled, newVal: newCfg.gateway.connectorsDefaultEnabled },
      { field: 'gateway.oauthReturnUrl', oldVal: oldCfg.gateway.oauthReturnUrl, newVal: newCfg.gateway.oauthReturnUrl },
    ];
    for (const { field, oldVal, newVal } of gatewayFieldPairs) {
      if (!deepEqual(oldVal, newVal)) {
        fieldChanges.push({
          agentId: '',
          field,
          oldValue: oldVal,
          newValue: newVal,
          hotReloadable: HOT_RELOADABLE_GATEWAY_FIELDS.includes(field),
        });
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
