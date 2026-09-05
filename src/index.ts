#!/usr/bin/env node

// Must run before any other imports so env vars are set before modules read them.
// TypeScript compiles imports to inline require() calls (CommonJS), so placement matters.
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadGatewayDotenv } from './load-dotenv';

// Load ~/.claude-gateway/.env so global installs pick up env vars without
// needing shell exports or running via npm start. Shared with src/entry.ts,
// which does the same before dispatching to the CLI.
loadGatewayDotenv();

import { loadConfig, logSkippedAgents, SkippedAgent } from './config/loader';
import { agentsDirForConfig, loadAgentEnvFiles } from './config/agent-env';
import { detectMigration, applyMigration, loadCleanTemplate } from './config/migrator';
import { ensureConfigExists, firstRunNotice } from './config/bootstrap';
import { loadWorkspace, watchWorkspace, migrateWorkspaceFiles, classifyWorkspaceRestart } from './agent/workspace-loader';
import { resolveArchiveConfig, makeSharedPromoter, resolveSharedConfig, resolveReflectionConfig, sharedVaultDir, SharedReflectionManager } from './agent/knowledge';
import { watchSkills } from './skills';
import { syncSharedSkills, syncModuleSkills } from './skills/sync';
import { createWatcher } from './watch/factory';
import { AgentRunner } from './agent/runner';
import { SkillLearningManager } from './agent/skill-learning';
import { DreamingManager } from './agent/dreaming';
import { makeRouteOut } from './agent/dreaming/migrate';
import { resolveDreamingConfig } from './agent/dreaming/config';
import { makeClaudeSpawn } from './agent/skill-learning/reviewer';
import { CronScheduler } from './cron/scheduler';
import { CronManager } from './cron/manager';
import { GatewayRouter } from './api/gateway-router';
import { ContextIsolationGuard } from './agent/context-isolation';
import { createLogger, configureLogging, loggingConfig, startLogRetentionSweep } from './logger';
import { ConfigWatcher, ConfigChange } from './config/watcher';
import { AgentConfig, GatewayConfig, LogsConfig } from './types';
import { AppsRegistry } from './apps/registry';
import { sweepOrphanedReceivers } from './utils/orphan-receivers';
import { registerShutdownSignals } from './shutdown-signals';
import { RegistryClient } from './apps/registry-client';
import { AppInstaller } from './apps/installer';
import { AgentManager } from './apps/agent-manager';
import { SocketServer, parseTimeoutMs } from './apps/socket-server';
import { parseAppYaml, AppYamlService, AppYamlScript } from './apps/compose-generator';
import { claimSupervisorEnv, classifyInvocation, resolveInvocationSignals } from './cli/command-names';
import { defaultPidfilePath } from './cli/manager';
import { expandHome as expandTilde } from './utils/paths';


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

const PORT = parseInt((process.env.PORT ?? '10850'), 10);

// Pidfile lets the CLI detect a foreground gateway (see src/cli/manager.ts).
const PIDFILE_PATH = defaultPidfilePath();

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
  /**
   * issue #392 part C: distinct resolved shared-vault roots a
   * `SharedReflectionManager` has already been started for. The reflection
   * pass is KB-level, not per-agent — however many agents share one vault
   * root, exactly one manager is started for it (keyed by `sharedVaultDir`).
   */
  reflectionVaultsStarted: Set<string>;
}

async function startAgent(
  agentConfig: AgentConfig,
  gatewayConfig: GatewayConfig,
  ctx: StartupContext,
): Promise<void> {
  const { agentRunners, agentConfigs, schedulers, startupResults, mcpToolsDir, sharedSkillsDir, logDir } = ctx;

  const logger = createLogger(agentConfig.id, logDir);
  logger.info('Initialising agent', { id: agentConfig.id });

  // Soft memory budgets for MEMORY.md/USER.md compose banners (issue #323).
  // Per-agent config wins field-by-field over the global gateway default
  // (mirrors the skillLearning override). loadWorkspace defaults any unset
  // field, so a fully-absent config is safe.
  const memoryBudget = { ...gatewayConfig.gateway.memory, ...agentConfig.memory };
  // K2 core-shrink is enabled only when the searchable archive is on — otherwise
  // the injected index would point at a memory_search tool with nothing behind it.
  const coreShrink = resolveArchiveConfig(
    agentConfig.knowledge?.archive,
    gatewayConfig.gateway.knowledge?.archive,
  ).enabled;

  // Ensure workspace directory exists (may be absent for newly created agents)
  try {
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
  } catch (err) {
    const reason = (err as Error).message;
    logger.error('Failed to create workspace directory', { error: reason });
    console.log(JSON.stringify({ id: agentConfig.id, status: 'failed', reason }));
    startupResults.push({ id: agentConfig.id, status: 'failed', workspace: agentConfig.workspace, reason });
    return;
  }

  // ── Migrate legacy lowercase workspace files (agent.md → AGENTS.md, etc.) ──
  if (fs.existsSync(agentConfig.workspace)) {
    try {
      migrateWorkspaceFiles(agentConfig.workspace);
    } catch (err) {
      logger.warn('Workspace migration failed', { error: (err as Error).message });
    }
  }

  // ── Create stub workspace files if missing (e.g. freshly-installed app-agents) ──
  const WORKSPACE_STUBS: Record<string, string> = {
    'AGENTS.md': `# Agent: ${agentConfig.id}\n`,
    'SOUL.md': '',
    'MEMORY.md': '',
  };
  for (const [filename, content] of Object.entries(WORKSPACE_STUBS)) {
    const filePath = path.join(agentConfig.workspace, filename);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
        logger.info(`Created stub ${filename}`);
      } catch (err) {
        logger.warn(`Failed to create stub ${filename}`, { error: (err as Error).message });
      }
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
      coreShrink,
      mcpToolsDir,
      sharedSkillsDir,
      logger,
      memoryBudget,
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

  // Skill self-improvement (planning-62): wire the manager (telemetry capture +
  // idle-review trigger + reviewer + writer) and start the daily curator. Shares
  // the runner's history DB so telemetry and the reviewer read the same tables.
  // Telemetry capture is always-on; the reviewer/writer/curator honor `enabled`.
  try {
    const skillLearning = new SkillLearningManager({
      db: runner.getHistoryDb(),
      agentId: agentConfig.id,
      workspaceDir: agentConfig.workspace,
      mcpToolsDir,
      sharedSkillsDir,
      globalCfg: gatewayConfig.gateway.skillLearning,
      agentCfg: agentConfig.skillLearning,
      logger,
      channels: {
        telegramBotToken: agentConfig.telegram?.botToken,
        discordBotToken: agentConfig.discord?.botToken,
        lineAccessToken: agentConfig.line?.channelAccessToken,
      },
    });
    runner.setSkillLearning(skillLearning);
    skillLearning.startCurator(); // unref'd self-rescheduling timer
  } catch (err) {
    logger.warn('Failed to wire skill-learning (continuing without it)', { error: (err as Error).message });
  }

  // ── Nightly memory dreaming (issue #325) — propose (dry-run) slice ──
  try {
    const dreaming = new DreamingManager({
      db: runner.getHistoryDb(),
      agentId: agentConfig.id,
      workspaceDir: agentConfig.workspace,
      globalCfg: gatewayConfig.gateway.dreaming,
      agentCfg: agentConfig.dreaming,
      logger,
      // K4 auto-applier net-negative gate uses the same soft budgets as compose.
      memoryBudgetChars: memoryBudget.memoryBudgetChars,
      userBudgetChars: memoryBudget.userBudgetChars,
      // planning-65: route episodic task-log to memory/<topic>.md when enabled.
      // Opt-in (=== true) to match compose; the template ships true so the migrator
      // turns it on for existing configs, and it stays off for anything pre-1.0.25
      // that hasn't merged the key yet (exact prior behavior).
      writeRouting: memoryBudget.writeRouting === true,
      episodicArchiveDir: memoryBudget.episodicArchiveDir,
      // planning-67: back the embedded auto-migrate route-out with a print-only
      // reviewer spawn (same model as the dreaming reviewer). Only when routing is
      // on; the manager gates it further on auto mode + over-budget + autoRouteOut.
      routeOutFn:
        memoryBudget.writeRouting === true
          ? makeRouteOut(
              makeClaudeSpawn(
                resolveDreamingConfig(agentConfig.dreaming, gatewayConfig.gateway.dreaming)
                  .reviewModel,
              ),
            )
          : undefined,
      // K3↔K4 promotion: only when the shared KB is enabled AND set to auto.
      sharedPromote: makeSharedPromoter(
        agentConfig.id,
        agentConfig.knowledge?.shared,
        gatewayConfig.gateway.knowledge?.shared,
        logger,
      ),
    });
    dreaming.startDreaming(); // unref'd nightly self-rescheduling timer
  } catch (err) {
    logger.warn('Failed to wire dreaming (continuing without it)', { error: (err as Error).message });
  }

  // ── Weekly shared-KB reflection pass (issue #392 part C) ──
  // KB-level, not per-agent: only the FIRST agent to resolve a given shared-
  // vault root starts a manager for it, so N agents sharing one vault still run
  // exactly one weekly reflection job, not N nightly ones.
  try {
    const sharedCfg = resolveSharedConfig(agentConfig.knowledge?.shared, gatewayConfig.gateway.knowledge?.shared);
    if (sharedCfg.enabled && sharedCfg.mode === 'auto') {
      const vaultKey = sharedVaultDir(sharedCfg);
      if (!ctx.reflectionVaultsStarted.has(vaultKey)) {
        ctx.reflectionVaultsStarted.add(vaultKey);
        const reflectionCfg = resolveReflectionConfig(
          agentConfig.knowledge?.reflection,
          gatewayConfig.gateway.knowledge?.reflection,
        );
        const reflection = new SharedReflectionManager({
          sharedCfg,
          reflectionCfg,
          logger,
          spawnFn: makeClaudeSpawn(reflectionCfg.reviewModel),
        });
        reflection.startReflecting(); // unref'd weekly self-rescheduling timer
      }
    }
  } catch (err) {
    logger.warn('Failed to wire shared-KB reflection (continuing without it)', { error: (err as Error).message });
  }

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
  watchWorkspace(agentConfig.workspace, async (changedFiles) => {
    logger.info('Workspace changed, reloading', { files: changedFiles });
    try {
      const updated = await loadWorkspace(agentConfig.workspace, {
        mcpToolsDir,
        sharedSkillsDir,
        logger,
        memoryBudget,
        coreShrink,
      });
      // Always rewrite CLAUDE.md so the next spawn picks up the new content.
      await fs.promises.writeFile(
        path.join(agentConfig.workspace, 'CLAUDE.md'),
        updated.systemPrompt,
        'utf8',
      );
      if (updated.skillRegistry) {
        runner.setSkillRegistry(updated.skillRegistry);
      }
      // CLAUDE.md is always recomposed on disk (above) and is frozen-at-spawn —
      // a live process never re-reads it; every future spawn picks up the new
      // content regardless. So the restart decision is purely about how urgently
      // the change must reach *already-running* sessions, tiered by change class.
      const restartAction = classifyWorkspaceRestart(changedFiles);
      if (restartAction === 'none') {
        // Self-authored memory (MEMORY.md/USER.md): the running session already
        // holds what it just wrote, and every future spawn reads the recomposed
        // CLAUDE.md. Restarting anything is pure downside (dropped in-context
        // state + SQLite replay). Restart NOTHING — this is the whole bug fix:
        // a memory write can never drop a live session again.
        logger.info('Updated CLAUDE.md (memory-only change), no session restart', {
          files: changedFiles,
        });
      } else if (restartAction === 'defer-idle') {
        // Operator identity (SOUL.md/AGENTS.md): reach sessions soon-ish, but
        // never SIGKILL an idle bystander. Skip busy (self-restart footgun) and
        // defer idle (lossless respawn on next message).
        logger.info('Updated CLAUDE.md (identity change), deferring restarts', {
          files: changedFiles,
        });
        await runner.restartOrDefer({ skipBusy: true, deferIdle: true });
      } else {
        // Non-writable change (HEARTBEAT.md, operator config, anything else):
        // keep the normal restart-or-defer behavior.
        logger.info('Updated CLAUDE.md, restarting sessions', { files: changedFiles });
        await runner.restartOrDefer({ skipBusy: false });
      }
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
          memoryBudget,
          coreShrink,
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
        // Refresh the skills registry for future spawns without dropping any
        // live session. Busy sessions are left running (skipBusy) — a session
        // that triggers a SKILL.md change mid-turn would otherwise stop itself
        // the instant its turn completes (the self-restart footgun). Idle
        // sessions are DEFERRED (deferIdle) rather than SIGKILLed: the skills
        // section of CLAUDE.md is frozen-at-spawn and the registry applies on
        // next spawn, so killing an idle bystander now buys nothing and only
        // drops its in-context state. Auto skill-learning writes skills mid-work,
        // so this keeps unrelated idle sessions alive. Both pick up the change
        // on their next spawn (busy: next natural spawn; idle: next message).
        await runner.restartOrDefer({ skipBusy: true, deferIdle: true });
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

async function restoreSockets(registry: AppsRegistry, socketServer: SocketServer): Promise<void> {
  const apps = await registry.list();
  for (const app of apps) {
    if (app.status !== 'running') continue;
    if (Object.keys(app.sockets).length === 0) continue;

    const yamlPath = path.join(app.installPath, 'app.yaml');
    if (!fs.existsSync(yamlPath)) continue;

    let appYaml: ReturnType<typeof parseAppYaml>;
    try {
      appYaml = parseAppYaml(fs.readFileSync(yamlPath, 'utf-8'), app.installPath);
    } catch {
      continue;
    }

    for (const [svcName, sockPath] of Object.entries(app.sockets)) {
      const svc = appYaml.services[svcName] as AppYamlService | undefined;
      if (!svc?.gateway_api) continue;

      try { fs.unlinkSync(sockPath); } catch { /* stale or absent */ }
      // Ensure socket directory is writable by the current process.
      // If owned by root (from a prior sudo run), remove and recreate it.
      // rmSync is wrapped: EPERM on rmSync must not skip the remaining sockets.
      const sockDir = path.dirname(sockPath);
      try {
        const dirStat = fs.statSync(sockDir, { throwIfNoEntry: false });
        if (dirStat) {
          try { fs.accessSync(sockDir, fs.constants.W_OK); } catch {
            fs.rmSync(sockDir, { recursive: true, force: true });
          }
        }
        fs.mkdirSync(sockDir, { recursive: true });
      } catch (err) {
        console.warn(`[gateway] Failed to prepare socket dir ${sockDir}: ${(err as Error).message} — skipping ${app.name}/${svcName}`);
        continue;
      }

      try {
        await socketServer.start(sockPath, {
          appName: app.name,
          serviceName: svcName,
          appDir: app.installPath,
          scripts: Object.fromEntries(
            Object.entries(svc.gateway_api.scripts ?? {}).map(([name, s]: [string, AppYamlScript]) => [
              name,
              { path: s.path, timeoutMs: parseTimeoutMs(s.timeout), args: s.args },
            ]),
          ),
        });
      } catch (err) {
        console.warn(`[gateway] Failed to restore socket for ${app.name}/${svcName}: ${(err as Error).message} — skipping`);
      }
    }
  }
}

// Module-level flag and shutdown reference so crash handlers can clean up child
// processes even when the error occurs outside main()'s try/catch scope.
let isShuttingDown = false;
let registeredShutdown: ((signal: string) => Promise<void>) | null = null;

async function main(): Promise<void> {
  // Load agent .env files before config interpolation so ${TOKEN} vars resolve.
  // ConfigWatcher repeats this before every reload, so agents that appear later
  // resolve too — see src/config/agent-env.ts.
  loadAgentEnvFiles(agentsDirForConfig(CONFIG_PATH));

  // ── First run: create config.json with a fresh admin key if none exists ───
  const templatePath = path.join(__dirname, '..', 'config.template.json');
  const bootstrap = ensureConfigExists(CONFIG_PATH, templatePath);
  if (bootstrap.created) {
    // The key itself is never printed — see firstRunNotice().
    for (const line of firstRunNotice(CONFIG_PATH, bootstrap.adminKey ?? '')) console.log(line);
  }

  // ── Auto-migrate config (add missing fields from template) ────────────────
  const templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  const templateVersion: string = templateJson.configVersion ?? '0.0.0';
  try {
    const detection = detectMigration(CONFIG_PATH, templatePath, templateVersion);
    if (detection.needed) {
      console.log(`[gateway] Config migration available (v${detection.fromVersion} -> v${detection.toVersion}). Auto-migrating...`);
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
      for (const warning of migration.warnings) {
        console.warn(`[gateway] ${warning}`);
      }
    }
  } catch (err) {
    console.warn(`[gateway] Config migration skipped: ${(err as Error).message}`);
  }

  console.log(`[gateway] Loading config from ${CONFIG_PATH}`);
  // Skips are collected rather than logged inline: the structured logger needs
  // config.gateway.logDir, so it cannot exist until this call returns. They are
  // replayed through globalLogger below so a dropped agent is diagnosable from
  // logs/gateway.log at startup too, not only on reload (#427).
  const startupSkips: SkippedAgent[] = [];
  const config: GatewayConfig = loadConfig(CONFIG_PATH, {
    onSkippedAgent: (s) => startupSkips.push(s),
  });
  config.gateway.logDir = expandTilde(config.gateway.logDir);

  // Must precede the first createLogger() call: the level gate and the rotation
  // thresholds are process-wide policy, and a logger created before the policy
  // is installed would run the whole boot on defaults.
  configureLogging(config.gateway.logs);

  // Created as early as logDir allows, and before the isolation guard below:
  // a config bad enough to drop an agent is exactly the config likely to fail
  // validation too, and a guard throw must not swallow the reason an agent
  // went missing.
  const globalLogger = createLogger('gateway', expandTilde(config.gateway.logDir));
  logSkippedAgents(globalLogger, startupSkips, 'Agent skipped at startup');

  // ── Context isolation check ──────────────────────────────────────────────
  const guard = new ContextIsolationGuard();
  guard.validate(config.agents);

  const agentRunners = new Map<string, AgentRunner>();
  const agentConfigs = new Map<string, AgentConfig>();
  const schedulers: CronScheduler[] = [];
  const startupResults: StartupResult[] = [];

  const sharedSkillsDir = path.join(os.homedir(), '.claude-gateway', 'shared-skills');
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const mcpToolsDir = path.resolve(__dirname, '..', 'mcp', 'tools');
  const logDir = expandTilde(config.gateway.logDir);

  // Signals are wired HERE, not after startup finishes. Boot spawns receivers
  // one agent at a time and can take a while (the orphan sweep alone waits out a
  // grace period), and until a handler exists a SIGHUP during that window kills
  // the gateway by default disposition and orphans every receiver started so
  // far — the same failure this file fixes (issue #405).
  //
  // The full teardown closes over components that do not exist yet, so the
  // handler delegates to it once available and otherwise does the subset that
  // matters this early: stopping the runners, which are what own receivers.
  let fullShutdown: ((signal: string) => Promise<void>) | null = null;
  const bootShutdown = async (signal: string): Promise<void> => {
    if (fullShutdown) return fullShutdown(signal);
    console.log(`[gateway] Received ${signal} during startup, shutting down...`);
    for (const scheduler of schedulers) scheduler.stop();
    await Promise.allSettled([...agentRunners.values()].map((runner) => runner.stop()));
    console.log('[gateway] Startup shutdown complete.');
  };
  registeredShutdown = registerShutdownSignals({
    run: bootShutdown,
    onBegin: () => { isShuttingDown = true; },
  });

  // Initial sync: copy shared and module skills to ~/.claude/skills/ so the Skill tool sees them
  syncSharedSkills(sharedSkillsDir, personalSkillsDir, globalLogger);
  syncModuleSkills(mcpToolsDir, personalSkillsDir, globalLogger);

  // Watch shared-skills for changes and re-sync to ~/.claude/skills/ on any update
  createWatcher({
    paths: [`${sharedSkillsDir}/**/SKILL.md`],
    debounceMs: 250,
    chokidarOpts: { depth: 2 },
    onChange: () => {
      syncSharedSkills(sharedSkillsDir, personalSkillsDir, globalLogger);
    },
  });

  // Watch module skills for changes and re-sync to ~/.claude/skills/
  createWatcher({
    paths: [`${mcpToolsDir}/**/skills/**/SKILL.md`],
    debounceMs: 250,
    chokidarOpts: { depth: 4 },
    onChange: () => {
      syncModuleSkills(mcpToolsDir, personalSkillsDir, globalLogger);
    },
  });

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
    reflectionVaultsStarted: new Set(),
  };

  // Reclaim receivers a previous gateway generation left behind before spawning
  // this one's. An exit that bypasses shutdown() — SIGKILL, the OOM killer, or a
  // SIGHUP on a pre-#405 build — reparents them to init, where they keep polling
  // their channel forever. Signal handling alone cannot cover SIGKILL/OOM, so
  // this sweep is the only path that recovers from them. See issue #405.
  //
  // Deliberately awaited before any agent starts: an orphan and a fresh receiver
  // polling the same bot token at once would race for every update, so the old
  // one must be gone before the new one exists.
  try {
    const sweep = await sweepOrphanedReceivers(mcpToolsDir);
    if (sweep.reclaimed.length > 0) {
      const forced = sweep.forced.length > 0 ? ` (${sweep.forced.length} needed SIGKILL)` : '';
      console.log(
        `[gateway] Reclaimed ${sweep.reclaimed.length} orphaned receiver process${sweep.reclaimed.length === 1 ? '' : 'es'}${forced}`,
      );
      for (const orphan of sweep.reclaimed) {
        globalLogger.info('Reclaimed orphaned receiver', { pid: orphan.pid, command: orphan.command });
      }
    }
    // Never fold these into the reclaimed count: they are still alive and still
    // polling their bot tokens, which is exactly what an operator needs to know.
    if (sweep.failed.length > 0) {
      console.warn(
        `[gateway] Could NOT reclaim ${sweep.failed.length} orphaned receiver process${sweep.failed.length === 1 ? '' : 'es'} — still running: ` +
          sweep.failed.map((f) => `${f.pid} (${f.reason})`).join(', '),
      );
      globalLogger.warn('Orphaned receivers could not be reclaimed', { failed: sweep.failed });
    }
  } catch (err) {
    // A host whose process list cannot be read must still boot — but never
    // silently: an unreadable `ps` means orphans are accumulating unseen.
    console.warn(`[gateway] Failed to sweep orphaned receivers: ${(err as Error).message}`);
    globalLogger.warn('Failed to sweep orphaned receivers', { error: (err as Error).message });
  }

  for (const agentConfig of config.agents) {
    // Expand ~ in workspace path so all downstream code uses absolute paths
    agentConfig.workspace = expandTilde(agentConfig.workspace);
    await startAgent(agentConfig, config, ctx);
  }

  // Print startup summary table
  printStartupTable(startupResults);

  // ── App store components ─────────────────────────────────────────────────
  const appsConfigPath = path.join(path.dirname(CONFIG_PATH), 'apps.json');
  const appsRegistry = new AppsRegistry(appsConfigPath);
  const registryClient = new RegistryClient();
  const agentManager = new AgentManager(CONFIG_PATH, agentsDirForConfig(CONFIG_PATH));
  const socketServer = new SocketServer();

  // Callbacks that bridge installer events to the router (filled in after router is created)
  const installerCallbacks = {
    registerRoutes: (_appName: string, _ports: import('./apps/compose-generator').ComposePort[]) => {
      // No-op until router is ready; router.loadProxyRoutes() handles startup restore
    },
    deregisterRoutes: (_appName: string) => {},
    startSocket: (_socketPath: string, _socket: import('./apps/compose-generator').ComposeSocket, _scripts: Record<string, import('./apps/installer').ScriptConfig>, _appDir: string) => Promise.resolve(),
    stopSockets: (_appName: string) => {},
    reinitializeAgent: async (agentName: string) => {
      const runner = ctx.agentRunners.get(agentName);
      const agentConfig = ctx.agentConfigs.get(agentName);
      if (!runner || !agentConfig) return; // first install — agent.added will call startAgent
      const logger = createLogger(agentName, ctx.logDir);
      try {
        const updated = await loadWorkspace(agentConfig.workspace, {
          mcpToolsDir: ctx.mcpToolsDir,
          sharedSkillsDir: ctx.sharedSkillsDir,
          logger,
          memoryBudget: { ...config.gateway.memory, ...agentConfig.memory },
          coreShrink: resolveArchiveConfig(
            agentConfig.knowledge?.archive,
            config.gateway.knowledge?.archive,
          ).enabled,
        });
        const claudeMdPath = path.join(agentConfig.workspace, 'CLAUDE.md');
        await fs.promises.writeFile(claudeMdPath, updated.systemPrompt, 'utf8');
        logger.info('Rewrote CLAUDE.md after reinstall', { chars: updated.systemPrompt.length });
        if (updated.skillRegistry) {
          runner.setSkillRegistry(updated.skillRegistry);
        }
      } catch (err) {
        logger.error('Failed to reinitialize agent workspace after reinstall', { error: (err as Error).message });
      }
    },
  };

  const appInstaller = new AppInstaller(
    appsRegistry,
    registryClient,
    installerCallbacks,
    undefined,
    undefined,
    agentManager,
    undefined,
    config.gateway.appHousekeeping,
    config.gateway?.appBackup,
    undefined,
    config.gateway?.appRestore,
  );

  // Reclaim update scratch dirs a previous crash left beside an install path.
  // Must run at boot, before any update can claim one of those names.
  try {
    const swept = await appInstaller.sweepStaleUpdateDirs();
    if (swept.length > 0) {
      console.log(`[gateway] Swept ${swept.length} stale app update director${swept.length === 1 ? 'y' : 'ies'}`);
    }
  } catch (err) {
    console.warn(`[gateway] Failed to sweep stale app update directories: ${(err as Error).message}`);
  }

  // Daily backup-cleanup scheduler (issue #310): prunes every app's backups by
  // the retention-count + max-age union policy. Timer is unref'd, so it never
  // keeps the process alive.
  appInstaller.startBackupCleanup();

  // Log retention (issue #435): sweeps once now and daily thereafter. Session
  // logs are the reason this is age-based — each session writes its own file
  // and never returns to it, so the per-stream generation cap cannot reach them.
  startLogRetentionSweep(logDir, (removed) => {
    globalLogger.info('Swept expired log files', {
      count: removed.length,
      // Read live rather than closing over the boot-time policy: `gateway.logs`
      // is hot-reloadable, so a captured value would report the threshold that
      // was in force at boot while the sweep used the current one.
      retentionDays: loggingConfig().retentionDays,
    });
  });

  // Mark the apps this boot will restore BEFORE the server accepts a single
  // request. The marks are what stop a status read from querying Docker, seeing
  // the containers the host reboot took down, and persisting `running` →
  // `stopped` underneath a restore that has not started yet — which would also
  // drop the app from the restore batch for good (#425). The restore itself
  // stays in the background below; only this cheap registry read is awaited.
  const restorePending = await appInstaller.markRestorePending();

  // Start gateway router
  const router = new GatewayRouter(agentRunners, agentConfigs, undefined, config, cronManager, CONFIG_PATH, appsRegistry, appInstaller, registryClient);
  await router.start(PORT);
  console.log(`[gateway] Listening on port ${PORT}`);

  // Write the pidfile so the CLI can detect a foreground gateway (and SIGTERM it
  // for `gateway stop/restart`). The listening port goes on the second line:
  // $PORT lives in the shell that launched the server, so a CLI run from
  // anywhere else cannot otherwise learn where to reach it. The real bound port
  // is used rather than the requested one, which is 0 when the OS picks.
  // Best-effort — never fail boot over it.
  try {
    fs.mkdirSync(path.dirname(PIDFILE_PATH), { recursive: true });
    fs.writeFileSync(PIDFILE_PATH, `${process.pid}\n${router.listeningPort() ?? PORT}\n`);
  } catch (e) {
    globalLogger.warn?.('Could not write pidfile', { path: PIDFILE_PATH, error: (e as Error).message });
  }

  // Wire installer callbacks now that the router is available
  installerCallbacks.registerRoutes = (appName, ports) => {
    for (const port of ports) {
      router.registerProxyRoute(appName, port.name, port.hostPort, port.type, port.rateLimit);
    }
  };
  installerCallbacks.deregisterRoutes = (appName) => {
    router.deregisterProxyRoutes(appName);
  };
  installerCallbacks.startSocket = (socketPath, socket, scripts, appDir) => {
    return socketServer.start(socketPath, {
      appName: socket.service.split('-')[0] ?? 'unknown',
      serviceName: socket.service,
      appDir,
      scripts: Object.fromEntries(
        Object.entries(scripts).map(([name, s]) => [
          name,
          {
            path: s.path,
            timeoutMs: parseTimeoutMs(s.timeout),
            args: s.args,
          },
        ]),
      ),
    });
  };
  installerCallbacks.stopSockets = (appName) => {
    socketServer.stopApp(appName);
  };

  // Compose has no host-reboot restart policy, so a running app's containers are
  // down after a restart. Bring them up in the BACKGROUND — fire-and-forget so it
  // never blocks the event loop or route wiring. Routes come up immediately below;
  // until each app's containers finish `compose up --wait`, a request may briefly
  // 502 (ECONNREFUSED), which self-heals within seconds. Non-fatal per app.
  // The batch was read and marked in flight before the server started listening,
  // so every app in it has been reporting `restoring` since the first request.
  void appInstaller
    .restoreRunningApps(restorePending)
    .then(({ attempted, failures }) => {
      for (const f of failures) {
        globalLogger.warn(`App store: failed to start "${f.app}" containers on restore (non-fatal): ${f.error}`);
      }
      if (attempted > 0) {
        globalLogger.info(`App store: background container restore complete (${attempted - failures.length}/${attempted} started)`);
      }
    })
    .catch((err) => {
      globalLogger.warn('App store: background container restore failed (non-fatal)', { error: (err as Error).message });
    });

  // Restore proxy routes, sockets, and agent entries for apps that were running before restart
  try {
    await router.loadProxyRoutes(appsRegistry);
    await restoreSockets(appsRegistry, socketServer);
    const reconcileErrors = await agentManager.reconcileAgents(appsRegistry);
    if (reconcileErrors.length > 0) {
      for (const e of reconcileErrors) {
        globalLogger.warn(`App store: reconcile failed for "${e.app}": ${e.error}`);
      }
    }
    globalLogger.info('App store: proxy routes, sockets, and agent entries restored');
  } catch (err) {
    globalLogger.warn('App store: startup restore failed (non-fatal)', { error: (err as Error).message });
  }

  // ── Config hot-reload watcher ──────────────────────────────────────────────
  const configWatcher = new ConfigWatcher(CONFIG_PATH, config, globalLogger);

  configWatcher.on('changes', (changes: ConfigChange[], newConfig: GatewayConfig) => {
    for (const change of changes) {
      if (!change.hotReloadable) continue;

      // Gateway-level changes (agentId === '')
      if (change.agentId === '') {
        if (change.field === 'gateway.headless') {
          // Applies to sessions spawned after the change; running sessions keep their backend.
          config.gateway.headless = change.newValue as boolean | undefined;
        } else if (change.field === 'gateway.customConnectors') {
          // Same "new spawns only" scope as the agent-level 'connectors' case
          // below — an already-running session's subprocess isn't hot-patched
          // (see restartSessionsUsingConnector for that case), but every
          // subsequent chat/spawn now sees connect/disconnect/add-custom
          // changes without a gateway restart.
          config.gateway.customConnectors = change.newValue as GatewayConfig['gateway']['customConnectors'];
        } else if (change.field === 'gateway.connectorsDefaultEnabled') {
          // Same "new spawns only" scope as customConnectors: both readers take
          // this off the live config object at call time, so replacing it is the
          // whole reload.
          config.gateway.connectorsDefaultEnabled = change.newValue as boolean | undefined;
        }
        if (change.field === 'gateway.logs') {
          // Re-installing the policy is enough: every logger reads it per call,
          // and the retention sweep reads `retentionDays` on each run.
          config.gateway.logs = change.newValue as LogsConfig | undefined;
          const applied = configureLogging(config.gateway.logs);
          // warn, not info: raising the level to `warn` would swallow an `info`
          // confirmation under the very policy just installed, leaving the
          // operator with no evidence the edit took.
          globalLogger.warn('Logging policy reloaded', { ...applied });
        }
        continue;
      }

      const agentConfig = agentConfigs.get(change.agentId);
      if (!agentConfig) continue;

      switch (change.field) {
        case 'claude.model':
          agentConfig.claude.model = change.newValue as string;
          break;
        case 'claude.extraFlags':
          agentConfig.claude.extraFlags = change.newValue as string[];
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
        case 'connectors':
          // Per-agent connector enablement toggles — same scope note as
          // gateway.customConnectors above.
          agentConfig.connectors = change.newValue as AgentConfig['connectors'];
          break;
      }
    }
  });

  configWatcher.on('agent.added', async (newAgentConfig: AgentConfig) => {
    globalLogger.info('New agent detected in config, starting dynamically', { id: newAgentConfig.id });

    // The agent's .env is already in process.env: ConfigWatcher.reload() folds
    // agents/<id>/.env in before interpolating, which is the only reason this
    // event can fire for a ${VAR}-token agent at all (#427).
    newAgentConfig.workspace = expandTilde(newAgentConfig.workspace);
    // `config`, not `configWatcher.getConfig()`. Every hot-reloadable
    // gateway-level field is applied by mutating this long-lived object in
    // place (the `changes` handler above), while getConfig() returns
    // `currentConfig` — a structuredClone that the NEXT reload() replaces
    // outright. An agent handed that clone therefore holds a snapshot frozen at
    // the moment it was added: AgentRunner keeps the reference for its lifetime
    // and reads `gateway.customConnectors` and `gateway.connectorsDefaultEnabled`
    // off it at spawn time, so connecting, disconnecting or adding a connector
    // afterwards would never reach the one agent that was hot-added — with no
    // error and nothing in the log, and a gateway restart as the only cure.
    // (`gateway.headless` has the same shape, which is how this got missed.)
    // Boot-path agents already get exactly this object; see startAgent above.
    await startAgent(newAgentConfig, config, ctx);
    globalLogger.info('Agent hot-added successfully', { id: newAgentConfig.id });
  });

  configWatcher.on('channel.added', async (agentId: string, channel: string) => {
    const runner = ctx.agentRunners.get(agentId);
    if (!runner) return;

    // Reload the agent config so runner has the new token
    const freshConfig = configWatcher.getConfig();
    const freshAgent = freshConfig.agents.find(a => a.id === agentId);
    if (!freshAgent) return;

    // Update runner's agentConfig so it has the new bot token
    // Expand ~ so downstream path.join calls produce absolute paths
    freshAgent.workspace = expandTilde(freshAgent.workspace);
    const agentRunner = runner as import('./agent/runner').AgentRunner;
    agentRunner.updateAgentConfig(freshAgent);

    if (channel === 'telegram') {
      agentRunner.startTelegramReceiver();
      globalLogger.info('Telegram channel hot-added to existing agent', { agentId });
    } else if (channel === 'discord') {
      agentRunner.startDiscordReceiver();
      globalLogger.info('Discord channel hot-added to existing agent', { agentId });
    }
  });

  configWatcher.on('channel.removed', (agentId: string, channel: string) => {
    const runner = ctx.agentRunners.get(agentId);
    if (!runner) return;

    const agentRunner = runner as import('./agent/runner').AgentRunner;
    if (channel === 'discord') {
      agentRunner.stopDiscordReceiver();
      globalLogger.info('Discord channel hot-removed from agent', { agentId });
    } else if (channel === 'telegram') {
      agentRunner.stopTelegramReceiver();
      globalLogger.info('Telegram channel hot-removed from agent', { agentId });
    }
  });

  configWatcher.start();

  // Graceful shutdown — idempotent: safe to call from multiple signal/error sources.
  const runShutdown = async (signal: string) => {
    console.log(`[gateway] Received ${signal}, shutting down...`);

    for (const scheduler of schedulers) {
      scheduler.stop();
    }

    cronManager.stop();
    configWatcher.stop();
    socketServer.stopAll();

    // Every teardown below must run even if an earlier one throws. Previously a
    // rejection here propagated and the process hung with its children still
    // parented — recoverable. Now that a failed shutdown exits the process, an
    // unguarded throw would *guarantee* the remaining receivers reparent to
    // init: precisely the bug this file is fixing (issue #405).
    const settled = await Promise.allSettled([
      router.stop(),
      // Runners stop concurrently, not serially. Teardown is now awaited, and
      // the Discord receiver always takes ~2s to exit (its receiver-server
      // force-exits on an unconditional timer), so serial stops would multiply
      // that by the agent count and risk a supervisor's stop timeout (docker
      // stop's 10s default, TimeoutStopSec) SIGKILLing the gateway mid-teardown
      // — re-orphaning the very receivers this protects.
      ...[...agentRunners.values()].map((runner) => runner.stop()),
    ]);

    for (const result of settled) {
      if (result.status === 'rejected') {
        console.error('[gateway] Shutdown step failed:', result.reason);
      }
    }

    // Remove the pidfile so the CLI does not treat a stale pid as a live gateway.
    try {
      fs.unlinkSync(PIDFILE_PATH);
    } catch {
      /* already gone — fine */
    }

    console.log('[gateway] Shutdown complete.');
  };

  // Hand the fully-wired teardown to the handlers registered at the top of
  // main(). From here a signal tears down everything; before it, the boot subset.
  fullShutdown = runShutdown;
}

async function emergencyShutdown(label: string, detail: unknown): Promise<void> {
  console.error(`[gateway] ${label}:`, detail);
  if (registeredShutdown && !isShuttingDown) {
    try {
      await registeredShutdown(label);
    } catch (e) {
      console.error('[gateway] Error during emergency shutdown:', e);
    }
  }
}

// Without these handlers, any unhandled rejection or uncaught exception crashes
// the process immediately via main().catch() — bypassing shutdown() and leaving
// child receiver processes (bun) alive as zombies that accumulate across restarts.
process.on('unhandledRejection', (reason) => {
  // If a clean SIGTERM shutdown is already in progress, don't interrupt it with
  // a crash exit — let the in-progress shutdown finish and exit 0.
  if (isShuttingDown) return;
  emergencyShutdown('unhandledRejection', reason).finally(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  if (isShuttingDown) return;
  emergencyShutdown('uncaughtException', err).finally(() => process.exit(1));
});

// Starting the gateway is intentionally explicit: only `gateway start` enters
// the server boot path. Every other invocation (including no args, --help, and
// typos) runs through the CLI so it cannot accidentally create a live server.
// The one exception is a supervised no-command launch from a pre-1.8 unit file,
// which still boots (with a warning) so existing installs don't restart-loop.
// The CLI runner remains lazy-loaded and is never imported on the server path.
const invocation = classifyInvocation(process.argv.slice(2), process.env, resolveInvocationSignals());
if (invocation === 'legacy-boot') {
  process.stderr.write(
    'DEPRECATED: starting the gateway with no command. Update this service to run ' +
      '`claude-gateway gateway start` (or reinstall with `claude-gateway service install`); ' +
      'a future release will print help and exit instead of starting.\n',
  );
}
if (invocation === 'boot' || invocation === 'legacy-boot') {
  // Before anything can spawn a child: the supervisor markers we were launched
  // with are inherited, and a descendant that still sees them would classify a
  // bare invocation as a service launch and boot a second server.
  claimSupervisorEnv(process.env);
  main().catch((err) => {
    emergencyShutdown('Fatal error in main()', err).finally(() => process.exit(1));
  });
} else {
  import('./cli')
    .then(({ runCli }) => runCli(process.argv.slice(2)))
    .then(async (code) => {
      const { exitAfterFlush } = await import('./cli/output');
      await exitAfterFlush(code);
    })
    .catch(async (err) => {
      process.stderr.write(`Error: ${err?.message ?? err}\n`);
      const { exitAfterFlush } = await import('./cli/output');
      await exitAfterFlush(1);
    });
}
