import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { AppsRegistry, AppEntry } from './registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPaths {
  claudeBin: string;
  nodeBin: string;
  npmRoot: string;
}

interface RawConfig {
  gateway: Record<string, unknown>;
  agents: Record<string, unknown>[];
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude-gateway', 'config.json');
const DEFAULT_AGENTS_DIR = path.join(os.homedir(), '.claude-gateway', 'agents');

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  /** Serialises concurrent config reads/writes within this process. */
  private configLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly configPath: string = DEFAULT_CONFIG_PATH,
    private readonly agentsDir: string = DEFAULT_AGENTS_DIR,
  ) {}

  private async withConfigLock<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const prev = this.configLock;
    this.configLock = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return fn();
    } finally {
      release();
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Detect host binary paths for injection into the agent container.
   * Runs once at install time; results stored in apps.json.
   */
  detectAgentPaths(): AgentPaths {
    const run = (cmd: string): string =>
      execSync(cmd, { encoding: 'utf-8' }).toString().trim();

    const claudeBin = run('which claude');
    const realClaudeBin = fs.realpathSync(claudeBin);
    const nodeBin = fs.realpathSync(run('which node'));
    const npmRoot = run('npm root -g');

    return { claudeBin: realClaudeBin, nodeBin, npmRoot };
  }

  /**
   * Inject the `agent` service into an already-generated docker-compose.yml.
   * No-op if entry has no agentDeclaration or agentPaths.
   *
   * Uses debian:stable-slim (glibc required — host node binary is glibc-linked).
   * All binaries and auth files are bind-mounted directly from their resolved host paths.
   */
  injectAgentService(entry: AppEntry): void {
    if (!entry.agentDeclaration || !entry.agentPaths) return;

    const composePath = path.join(entry.installPath, 'docker-compose.yml');
    const raw = fs.readFileSync(composePath, 'utf-8');
    const compose = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA }) as Record<string, unknown>;

    const { name: agentName, path: agentRelPath } = entry.agentDeclaration;
    const { claudeBin, nodeBin, npmRoot } = entry.agentPaths;
    const homeDir = os.homedir();
    // Resolve symlinks so Docker daemon gets the real path — avoids Docker creating
    // a root-owned empty directory instead of bind-mounting the existing one.
    const workspaceDir = fs.realpathSync(path.join(entry.installPath, agentRelPath));

    let uid = 1000;
    try { uid = os.userInfo().uid; } catch { /* use 1000 */ }

    // Claude Code rewrites ~/.claude.json atomically at startup (write temp +
    // rename over the target). Bind-mounting the host file at its real path makes
    // that rename fail with `Device or resource busy` (a mountpoint cannot be
    // replaced via rename, regardless of ro/rw), so the session cannot persist the
    // auth state carried by settings.json's env block and falls back to
    // "Not logged in". Instead we bind-mount the host file to a read-only *seed*
    // path (host file never mutated) and copy it into a writable ~/.claude.json at
    // container start (see `command` below) so the atomic rewrite succeeds. The
    // copy targets the literal homeDir: container-start HOME is `/`, but the
    // gateway runs turns with `docker exec -e HOME=<homeDir>` (see process.ts).
    const claudeJsonSeed = `${homeDir}/.claude.json.seed`;

    // Mount the agent's media directory into the container at the SAME absolute
    // path as the host. The gateway hands the agent uploaded-image paths (and the
    // browser-screenshot dir) as raw host paths under <agentsDir>/<agentName>/media
    // — a sibling of workspace, so outside the /workspace mount and never
    // translated. Mounting it at the identical path lets those raw paths resolve
    // inside the container with zero translation. Pre-create it (like ~/.claude
    // above) so Docker bind-mounts an existing uid-owned dir instead of a
    // root-owned one; :rw because browser screenshots write here. realpathSync
    // gives the Docker daemon the real source while the destination stays the
    // host-identical path the agent is handed.
    const agentMediaDir = path.join(this.agentsDir, agentName, 'media');
    fs.mkdirSync(agentMediaDir, { recursive: true });
    const agentMediaSource = fs.realpathSync(agentMediaDir);

    // Write Dockerfile.agent: install curl + pre-create ~/.claude owned by host uid so
    // Docker bind-mounts land inside a uid-1000-owned dir and Claude Code can freely
    // create subdirs (session-env, todos, etc.) at runtime without cap_drop: ALL blocking chown.
    const dockerfileAgentPath = path.join(entry.installPath, 'Dockerfile.agent');
    fs.writeFileSync(dockerfileAgentPath, [
      'FROM debian:stable-slim',
      `RUN apt-get update && apt-get install -y curl --no-install-recommends \\`,
      `    && rm -rf /var/lib/apt/lists/* \\`,
      `    && mkdir -p ${homeDir}/.claude \\`,
      `    && chown -R ${uid}:${uid} ${homeDir}`,
    ].join('\n') + '\n');

    const agentService = {
      build: { context: entry.installPath, dockerfile: 'Dockerfile.agent' },
      user: `${uid}:${uid}`,
      // Seed a writable ~/.claude.json from the read-only seed mount, then idle.
      // `cp` overwrites on every (re)start so the container always picks up the
      // current host auth; `exec` keeps the container's PID 1 as sleep.
      command: `sh -c 'cp ${claudeJsonSeed} ${homeDir}/.claude.json && exec sleep infinity'`,
      container_name: `${entry.name}-agent`,
      restart: 'unless-stopped',
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges'],
      env_file: '.env',
      volumes: [
        `${claudeBin}:${claudeBin}:ro`,
        `${nodeBin}:/usr/bin/node:ro`,
        `${npmRoot}:${npmRoot}:ro`,
        `${homeDir}/.claude.json:${claudeJsonSeed}:ro`,
        `${homeDir}/.claude/settings.json:${homeDir}/.claude/settings.json:ro`,
        `${workspaceDir}:/workspace`,
        `${agentMediaSource}:${agentMediaDir}:rw`,
      ],
    };

    const services = (compose.services ?? {}) as Record<string, unknown>;
    services['agent'] = agentService;
    compose['services'] = services;

    fs.writeFileSync(composePath, yaml.dump(compose, { lineWidth: -1 }), 'utf-8');
  }

  /**
   * Create ~/.claude-gateway/agents/{agentName} → ~/.claude-gateway/apps/{app}/agent
   * symlink and upsert the config.json entry.
   *
   * Docker mounts the real targetDir directly, so it never touches this symlink
   * and cannot pre-create it as a root-owned directory.
   * Idempotent — safe to call multiple times (reconcile, reinstall).
   */
  async upsertAgent(entry: AppEntry): Promise<void> {
    if (!entry.agentDeclaration || !entry.agentPaths) return;

    const { name: agentName, path: agentRelPath } = entry.agentDeclaration;
    // Layout mirrors a normal agent: agents/{agentName}/ (real dir) + workspace/ (symlink)
    // This ensures process.ts configPath resolution (workspace/../../.. → gateway base) is correct.
    const agentDir = path.join(this.agentsDir, agentName);
    const workspaceLink = path.join(agentDir, 'workspace');
    const targetDir = fs.realpathSync(path.join(entry.installPath, agentRelPath));

    fs.mkdirSync(agentDir, { recursive: true });

    try { fs.rmSync(workspaceLink, { force: true, recursive: true }); } catch { /* ignore */ }
    fs.symlinkSync(targetDir, workspaceLink);

    try {
      await this.upsertConfigEntry(agentName, {
        id: agentName,
        type: 'app-agent',
        description: `Agent for app ${entry.name}`,
        container: `${entry.name}-agent`,
        claudeBin: entry.agentPaths.claudeBin,
        workspace: workspaceLink,
        env: '',
        allow_tools: true,
        claude: {
          model: 'claude-sonnet-4-6',
          extraFlags: [],
        },
      });
    } catch (err) {
      // Rollback workspace symlink if config write fails to avoid orphaned symlink
      try { fs.rmSync(workspaceLink, { force: true }); } catch { /* best-effort */ }
      throw err;
    }
  }

  /**
   * Remove the workspace symlink and config entry for this app's agent.
   * Preserves the agent dir (and its sessions) so reinstalling picks up history.
   */
  async deleteAgent(entry: AppEntry): Promise<void> {
    if (!entry.agentDeclaration) return;
    await this.deleteAgentByName(entry.agentDeclaration.name);
  }

  /**
   * Remove by agent name — used in install rollback where AppEntry may not be in scope.
   * Only removes the workspace symlink; preserves sessions/ and other data so that
   * a reinstall picks up the same conversation history.
   */
  async deleteAgentByName(agentName: string): Promise<void> {
    const workspaceLink = path.join(this.agentsDir, agentName, 'workspace');
    // Only remove the symlink an app-agent owns — never a user agent's real
    // workspace directory that may sit at the same path under a shared name.
    try {
      if (fs.lstatSync(workspaceLink).isSymbolicLink()) {
        fs.rmSync(workspaceLink, { force: true });
      }
    } catch { /* already gone */ }
    await this.removeConfigEntry(agentName);
  }

  /**
   * Idempotent reconcile — called at gateway startup to ensure all app-agents
   * that are running have their symlink + config.json entry in place.
   * Returns a list of errors for apps that could not be reconciled (non-fatal).
   */
  async reconcileAgents(registry: AppsRegistry): Promise<Array<{ app: string; error: string }>> {
    const apps = await registry.list();
    const errors: Array<{ app: string; error: string }> = [];
    for (const app of apps) {
      if (app.agentDeclaration && app.status === 'running') {
        try {
          await this.upsertAgent(app);
        } catch (err) {
          errors.push({ app: app.name, error: (err as Error).message });
        }
      }
    }
    return errors;
  }

  /**
   * Read MEMORY.md for the given agent, returning its content or null if absent.
   * Called before an update to preserve agent memory across version swaps.
   */
  backupMemory(agentName: string): string | null {
    const workspace = this.getWorkspacePath(agentName);
    if (!workspace) return null;
    try {
      return fs.readFileSync(path.join(workspace, 'MEMORY.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Write MEMORY.md back after a successful update.
   */
  restoreMemory(agentName: string, content: string): void {
    const workspace = this.getWorkspacePath(agentName);
    if (!workspace) return;
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), content, 'utf-8');
  }

  private getWorkspacePath(agentName: string): string | null {
    const config = this.readConfig();
    const agent = config.agents.find((a) => a['id'] === agentName && a['type'] === 'app-agent');
    return agent ? (agent['workspace'] as string) : null;
  }

  /**
   * Return the agentName registered for a given appName, or null if none.
   * Used by the installer conflict check.
   */
  async findAgentByName(agentName: string): Promise<string | null> {
    return this.withConfigLock(() => {
      const config = this.readConfig();
      const found = config.agents.find(
        (a) => a['id'] === agentName && a['type'] === 'app-agent',
      );
      return found ? (found['id'] as string) : null;
    });
  }

  // ─── Config I/O ────────────────────────────────────────────────────────────

  private readConfig(): RawConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as RawConfig;
      if (!Array.isArray(parsed.agents)) parsed.agents = [];
      return parsed;
    } catch {
      return { gateway: { logDir: 'logs', timezone: 'UTC' }, agents: [] };
    }
  }

  private writeConfig(config: RawConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, this.configPath);
  }

  private async upsertConfigEntry(agentId: string, entry: Record<string, unknown>): Promise<void> {
    return this.withConfigLock(() => {
      const config = this.readConfig();
      const idx = config.agents.findIndex((a) => a['id'] === agentId);
      if (idx >= 0) {
        config.agents[idx] = entry;
      } else {
        config.agents.push(entry);
      }
      this.writeConfig(config);
    });
  }

  private async removeConfigEntry(agentId: string): Promise<void> {
    return this.withConfigLock(() => {
      const config = this.readConfig();
      // Only ever remove the app-agent entry — never a user-created agent that
      // happens to share the same id. All callers operate on app agents.
      config.agents = config.agents.filter(
        (a) => !(a['id'] === agentId && a['type'] === 'app-agent'),
      );
      this.writeConfig(config);
    });
  }
}
