import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
import { loadConfig } from './config/loader';
import { detectMigration, applyMigration, loadCleanTemplate } from './config/migrator';
import { loadWorkspace, watchWorkspace, migrateWorkspaceFiles } from './agent/workspace-loader';
import { watchSkills } from './skills';
import { syncSharedSkills } from './skills/sync';
import { createWatcher } from './watch/factory';
import { AgentRunner } from './agent/runner';
import { CronScheduler } from './cron/scheduler';
import { CronManager } from './cron/manager';
import { GatewayRouter } from './api/gateway-router';
import { ContextIsolationGuard } from './agent/context-isolation';
import { createLogger } from './logger';
import { ConfigWatcher, ConfigChange } from './config/watcher';
import { AgentConfig, GatewayConfig } from './types';

// ─── Simple argument parsing (no heavy deps) ──────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

const args = parseArgs(process.argv);

const CONFIG_PATH: string = expandTilde(
  (args['config'] as string | undefined) ??
  process.env.GATEWAY_CONFIG ??
  path.join(os.homedir(), '.claude-gateway', 'config.json')
);

const PORT = parseInt((process.env.PORT ?? '3000'), 10);

// ─── Startup summary table ────────────────────────────────────────────────────
interface StartupResult {
  id: string;
  status: 'started' | 'failed';
  workspace: string;
  reason?: string;
}

function printStartupTable(results: StartupResult[]): void {
  const COL_ID = Math.max(13, ...results.map((r) => r.id.length)) + 2;
  const COL_STATUS = 12;
  const COL_WORKSPACE = Math.max(40, ...results.map((r) => (r.reason ?? r.workspace).length)) + 2;

  const top    = `┌${'─'.repeat(COL_ID)}┬${'─'.repeat(COL_STATUS)}┬${'─'.repeat(COL_WORKSPACE)}┐`;
  const header = `│ ${'Agent'.padEnd(COL_ID - 2)} │ ${'Status'.padEnd(COL_STATUS - 2)} │ ${'Workspace'.padEnd(COL_WORKSPACE - 2)} │`;
  const mid    = `├${'─'.repeat(COL_ID)}┼${'─'.repeat(COL_STATUS)}┼${'─'.repeat(COL_WORKSPACE)}┤`;
  const bot    = `└${'─'.repeat(COL_ID)}┴${'─'.repeat(COL_STATUS)}┴${'─'.repeat(COL_WORKSPACE)}┘`;

  console.log(top);
  console.log(header);
  console.log(mid);

  for (const r of results) {
    const statusStr = r.status === 'started' ? '✓ ready' : '✗ failed';
    const wsStr = r.status === 'failed' && r.reason ? r.reason : r.workspace;
    console.log(
      `│ ${r.id.padEnd(COL_ID - 2)} │ ${statusStr.padEnd(COL_STATUS - 2)} │ ${wsStr.padEnd(COL_WORKSPACE - 2)} │`,
    );
  }

  console.log(bot);
}

// ─── Workspace validation ─────────────────────────────────────────────────────
function validateWorkspaceFast(workspacePath: string): { ok: true } | { ok: false; reason: string } {
  // Check workspace directory exists
  if (!fs.existsSync(workspacePath)) {
    return { ok: false, reason: 'workspace directory not found' };
  }
  // Check required AGENTS.md
  const agentMd = path.join(workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentMd)) {
    return { ok: false, reason: 'workspace missing AGENTS.md' };
  }
  return { ok: true };
}

/**
 * Load .env from a single agent's env file into process.env.
 * Values already in process.env win (existing env vars take priority).
 */
function loadAgentEnvFile(envFile: string): void {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Load .env files from the gateway agents directory into process.env.
 * Each agent may have a .env at ~/.claude-gateway/agents/<id>/.env
 * containing bot tokens and other secrets. Values already in process.env win.
 */
function loadAgentEnvFiles(gatewayAgentsDir: string): void {
  if (!fs.existsSync(gatewayAgentsDir)) return;
  for (const agentId of fs.readdirSync(gatewayAgentsDir)) {
    const envFile = path.join(gatewayAgentsDir, agentId, '.env');
    if (!fs.existsSync(envFile)) continue;
    loadAgentEnvFile(envFile);
  }
}

// ─── Context shared between startAgent calls ──────────────────────────────────
interface StartupContext {
  agentRunners: Map<string, AgentRunner>;
  agentConfigs: Map<string, AgentConfig>;
  schedulers: CronScheduler[];
  startupResults: StartupResult[];
  mcpToolsDir: string;
  sharedSkillsDir: string;
  logDir: string;
  cronManager: CronManager;
}

async function startAgent(
  agentConfig: AgentConfig,
  gatewayConfig: GatewayConfig,
  ctx: StartupContext,
): Promise<void> {
  const { agentRunners, agentConfigs, schedulers, startupResults, mcpToolsDir, sharedSkillsDir, logDir } = ctx;

  const logger = createLogger(agentConfig.id, logDir);
  logger.info('Initialising agent', { id: agentConfig.id });

  // ── Migrate legacy lowercase workspace files (agent.md → AGENTS.md, etc.) ──
  if (fs.existsSync(agentConfig.workspace)) {
    try {
      migrateWorkspaceFiles(agentConfig.workspace);
    } catch (err) {
      logger.warn('Workspace migration failed', { error: (err as Error).message });
    }
  }

  // ── Per-agent workspace validation (fail fast per-agent, not whole gateway) ──
  const validation = validateWorkspaceFast(agentConfig.workspace);
  if (!validation.ok) {
    logger.error('Workspace validation failed', { reason: validation.reason });
    console.log(JSON.stringify({ id: agentConfig.id, status: 'failed', reason: validation.reason }));
    startupResults.push({ id: agentConfig.id, status: 'failed', workspace: agentConfig.workspace, reason: validation.reason });
    return;
  }

  // Load workspace
  let workspace;
  try {
    workspace = await loadWorkspace(agentConfig.workspace, {
      mcpToolsDir,
      sharedSkillsDir,
      logger,
    });
  } catch (err) {
    const reason = (err as Error).message;
    logger.error('Failed to load workspace', { error: reason });
    console.log(JSON.stringify({ id: agentConfig.id, status: 'failed', reason }));
    startupResults.push({ id: agentConfig.id, status: 'failed', workspace: agentConfig.workspace, reason });
    return;
  }

  logger.info('Workspace loaded', {
    truncated: workspace.truncated,
  });

  // Write assembled system prompt to CLAUDE.md so Claude Code subprocess picks it up
  const claudeMdPath = path.join(agentConfig.workspace, 'CLAUDE.md');
  try {
    await fs.promises.writeFile(claudeMdPath, workspace.systemPrompt, 'utf8');
    logger.info('Wrote CLAUDE.md', { path: claudeMdPath, chars: workspace.systemPrompt.length });
  } catch (err) {
    const reason = (err as Error).message;
    logger.error('Failed to write CLAUDE.md', { error: reason });
    console.log(JSON.stringify({ id: agentConfig.id, status: 'failed', reason }));
    startupResults.push({ id: agentConfig.id, status: 'failed', workspace: agentConfig.workspace, reason });
    return;
  }

  // Create runner
  let runner: AgentRunner;
  try {
    runner = new AgentRunner(agentConfig, gatewayConfig, logger);
    if (workspace.skillRegistry) {
      runner.setSkillRegistry(workspace.skillRegistry);
    }
    await runner.start();
  } catch (err) {
    const reason = (err as Error).message;
    logger.error('Failed to start agent runner', { error: reason });
    console.log(JSON.stringify({ id: agentConfig.id, status: 'failed', reason }));
    startupResults.push({ id: agentConfig.id, status: 'failed', workspace: agentConfig.workspace, reason });
    return;
  }

  agentRunners.set(agentConfig.id, runner);
  agentConfigs.set(agentConfig.id, agentConfig);

  // Log startup status
  console.log(JSON.stringify({ id: agentConfig.id, status: 'started' }));
  logger.info('Agent started');

  // Create scheduler
  const scheduler = new CronScheduler(agentConfig.id, runner, logger, agentConfig);
  if (workspace.files.heartbeatMd) {
    scheduler.load(workspace.files.heartbeatMd);
  }
  schedulers.push(scheduler);

  // Watch workspace for changes
  watchWorkspace(agentConfig.workspace, async () => {
    logger.info('Workspace changed, reloading');
    try {
      const updated = await loadWorkspace(agentConfig.workspace, {
        mcpToolsDir,
        sharedSkillsDir,
        logger,
      });
      // Rewrite CLAUDE.md with updated system prompt and restart subprocess
      await fs.promises.writeFile(
        path.join(agentConfig.workspace, 'CLAUDE.md'),
        updated.systemPrompt,
        'utf8',
      );
      logger.info('Updated CLAUDE.md, restarting sessions');
      if (updated.skillRegistry) {
        runner.setSkillRegistry(updated.skillRegistry);
      }
      await runner.restartOrDefer();
      scheduler.load(updated.files.heartbeatMd);
    } catch (err) {
      logger.error('Failed to reload workspace', { error: (err as Error).message });
    }
  });

  // Watch skill directories for hot-reload (SKILL.md add/modify/delete)
  const workspaceSkillsDir = path.join(agentConfig.workspace, 'skills');
  watchSkills({
    dirs: [workspaceSkillsDir, mcpToolsDir, sharedSkillsDir],
    onChange: async () => {
      logger.info('Skills changed, reloading registry');
      try {
        const updated = await loadWorkspace(agentConfig.workspace, {
          mcpToolsDir,
          sharedSkillsDir,
          logger,
        });
        if (updated.skillRegistry) {
          runner.setSkillRegistry(updated.skillRegistry);
        }
        // Rewrite CLAUDE.md with updated skills section
        await fs.promises.writeFile(
          path.join(agentConfig.workspace, 'CLAUDE.md'),
          updated.systemPrompt,
          'utf8',
        );
        // Stop idle subprocesses now; busy sessions are deferred until
        // their current turn completes, then restarted automatically.
        await runner.restartOrDefer();
        logger.info('Skills registry updated', {
          count: updated.skillRegistry?.skills.size ?? 0,
        });
      } catch (err) {
        logger.error('Failed to reload skills', { error: (err as Error).message });
      }
    },
  });

  startupResults.push({ id: agentConfig.id, status: 'started', workspace: agentConfig.workspace });
}

async function main(): Promise<void> {
  // Load agent .env files before config interpolation so ${TOKEN} vars resolve
  const gatewayAgentsDir = path.join(path.dirname(CONFIG_PATH), 'agents');
  loadAgentEnvFiles(gatewayAgentsDir);

  // ── Auto-migrate config (add missing fields from template) ────────────────
  const templatePath = path.join(__dirname, '..', 'config.template.json');
  const templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  const templateVersion: string = templateJson.configVersion ?? '0.0.0';
  try {
    const detection = detectMigration(CONFIG_PATH, templatePath, templateVersion);
    if (detection.needed) {
      let shouldMigrate = false;

      if (args['auto-migrate']) {
        shouldMigrate = true;
      } else {
        // Prompt user for confirmation
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `[gateway] Config migration available (v${detection.fromVersion} -> v${detection.toVersion}). Migrate config? (y/n) [y]: `,
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            },
          );
        });
        shouldMigrate = answer === '' || answer === 'y' || answer === 'yes';
      }

      if (shouldMigrate) {
        const { ignorePaths, removePaths } = loadCleanTemplate(templatePath);
        const migration = applyMigration(
          CONFIG_PATH,
          detection.config,
          detection.template,
          templateVersion,
          ignorePaths,
          removePaths,
        );
        const parts = [`migrated to v${templateVersion}`];
        if (migration.addedFields.length) parts.push(`added: ${migration.addedFields.join(', ')}`);
        if (migration.removedFields.length) parts.push(`removed: ${migration.removedFields.join(', ')}`);
        console.log(`[gateway] Config ${parts.join(', ')}.`);
      } else {
        console.warn(`[gateway] Config migration skipped by user. Running with current config.`);
      }
    }
  } catch (err) {
    console.warn(`[gateway] Config migration skipped: ${(err as Error).message}`);
  }

  console.log(`[gateway] Loading config from ${CONFIG_PATH}`);
  const config: GatewayConfig = loadConfig(CONFIG_PATH);
  config.gateway.logDir = expandTilde(config.gateway.logDir);

  // ── Context isolation check ──────────────────────────────────────────────
  const guard = new ContextIsolationGuard();
  guard.validate(config.agents);

  const agentRunners = new Map<string, AgentRunner>();
  const agentConfigs = new Map<string, AgentConfig>();
  const schedulers: CronScheduler[] = [];
  const startupResults: StartupResult[] = [];

  const sharedSkillsDir = path.join(os.homedir(), '.claude-gateway', 'shared-skills');
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const globalLogger = createLogger('gateway', expandTilde(config.gateway.logDir));

  // Initial sync: copy shared skills to ~/.claude/skills/ so the Skill tool sees them
  syncSharedSkills(sharedSkillsDir, personalSkillsDir, globalLogger);

  // Watch shared-skills for changes and re-sync to ~/.claude/skills/ on any update
  createWatcher({
    paths: [`${sharedSkillsDir}/**/SKILL.md`],
    debounceMs: 250,
    chokidarOpts: { depth: 2 },
    onChange: () => {
      syncSharedSkills(sharedSkillsDir, personalSkillsDir, globalLogger);
    },
  });

  const mcpToolsDir = path.resolve(__dirname, '..', 'mcp', 'tools');
  const logDir = expandTilde(config.gateway.logDir);

  // Start persistent cron manager (needed before startAgent so hot-added agents can reference it)
  const cronManager = new CronManager(
    {
      storePath: path.join(path.dirname(CONFIG_PATH), 'crons.json'),
      runsDir: path.join(path.dirname(CONFIG_PATH), 'cron-runs'),
    },
    agentRunners,
    agentConfigs,
    createLogger('cron-manager', expandTilde(config.gateway.logDir)),
  );
  await cronManager.start();

  const ctx: StartupContext = {
    agentRunners,
    agentConfigs,
    schedulers,
    startupResults,
    mcpToolsDir,
    sharedSkillsDir,
    logDir,
    cronManager,
  };

  for (const agentConfig of config.agents) {
    // Expand ~ in workspace path so all downstream code uses absolute paths
    agentConfig.workspace = expandTilde(agentConfig.workspace);
    await startAgent(agentConfig, config, ctx);
  }

  // Print startup summary table
  printStartupTable(startupResults);

  // Start gateway router
  const router = new GatewayRouter(agentRunners, agentConfigs, undefined, config, cronManager);
  await router.start(PORT);
  console.log(`[gateway] Listening on port ${PORT}`);

  // ── Config hot-reload watcher ──────────────────────────────────────────────
  const configWatcher = new ConfigWatcher(CONFIG_PATH, config, globalLogger);

  configWatcher.on('changes', (changes: ConfigChange[], newConfig: GatewayConfig) => {
    for (const change of changes) {
      if (!change.hotReloadable) continue;

      const agentConfig = agentConfigs.get(change.agentId);
      if (!agentConfig) continue;

      switch (change.field) {
        case 'claude.model':
          agentConfig.claude.model = change.newValue as string;
          break;
        case 'claude.extraFlags':
          agentConfig.claude.extraFlags = change.newValue as string[];
          break;
        case 'claude.dangerouslySkipPermissions':
          agentConfig.claude.dangerouslySkipPermissions = change.newValue as boolean;
          break;
        case 'session.idleTimeoutMinutes':
          if (!agentConfig.session) agentConfig.session = {};
          agentConfig.session.idleTimeoutMinutes = change.newValue as number;
          break;
        case 'session.maxConcurrent':
          if (!agentConfig.session) agentConfig.session = {};
          agentConfig.session.maxConcurrent = change.newValue as number;
          break;
        case 'heartbeat.rateLimitMinutes':
          if (!agentConfig.heartbeat) agentConfig.heartbeat = {};
          agentConfig.heartbeat.rateLimitMinutes = change.newValue as number;
          break;
      }
    }
  });

  configWatcher.on('agent.added', async (newAgentConfig: AgentConfig) => {
    globalLogger.info('New agent detected in config, starting dynamically', { id: newAgentConfig.id });

    // Load .env for new agent so token interpolation works before startAgent
    const agentEnvFile = path.join(gatewayAgentsDir, newAgentConfig.id, '.env');
    if (fs.existsSync(agentEnvFile)) {
      loadAgentEnvFile(agentEnvFile);
    }

    newAgentConfig.workspace = expandTilde(newAgentConfig.workspace);
    await startAgent(newAgentConfig, configWatcher.getConfig(), ctx);
    globalLogger.info('Agent hot-added successfully', { id: newAgentConfig.id });
  });

  configWatcher.on('channel.added', async (agentId: string, channel: string) => {
    const runner = ctx.agentRunners.get(agentId);
    if (!runner) return;

    // Load fresh .env so new token is available before starting receiver
    const agentEnvFile = path.join(gatewayAgentsDir, agentId, '.env');
    if (fs.existsSync(agentEnvFile)) {
      loadAgentEnvFile(agentEnvFile);
    }

    // Reload the agent config so runner has the new token
    const freshConfig = configWatcher.getConfig();
    const freshAgent = freshConfig.agents.find(a => a.id === agentId);
    if (!freshAgent) return;

    if (channel === 'discord') {
      (runner as import('./agent/runner').AgentRunner).startDiscordReceiver();
      globalLogger.info('Discord channel hot-added to existing agent', { agentId });
    }
  });

  configWatcher.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[gateway] Received ${signal}, shutting down...`);

    for (const scheduler of schedulers) {
      scheduler.stop();
    }

    cronManager.stop();
    configWatcher.stop();

    await router.stop();

    for (const runner of agentRunners.values()) {
      await runner.stop();
    }

    console.log('[gateway] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
