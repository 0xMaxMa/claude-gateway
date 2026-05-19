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
    return {
      claudeBin: run('which claude'),
      nodeBin: run('which node'),
      npmRoot: run('npm root -g'),
    };
  }

  /**
   * Inject the `agent` service into an already-generated docker-compose.yml.
   * No-op if entry has no agentDeclaration or agentPaths.
   */
  injectAgentService(entry: AppEntry): void {
    if (!entry.agentDeclaration || !entry.agentPaths) return;

    const composePath = path.join(entry.installPath, 'docker-compose.yml');
    const raw = fs.readFileSync(composePath, 'utf-8');
    const compose = yaml.load(raw) as Record<string, unknown>;

    const { claudeBin, nodeBin, npmRoot } = entry.agentPaths;
    const { name: agentName } = entry.agentDeclaration;
    const workspacePath = path.join(this.agentsDir, agentName, 'workspace');
    const homeDir = os.homedir();

    const agentService = {
      image: 'debian:stable-slim',
      command: 'sleep infinity',
      container_name: `${entry.name}-agent`,
      restart: 'unless-stopped',
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges'],
      volumes: [
        `${claudeBin}:${claudeBin}:ro`,
        `${nodeBin}:${nodeBin}:ro`,
        `${npmRoot}:${npmRoot}:ro`,
        `${homeDir}/.claude.json:${homeDir}/.claude.json:ro`,
        `${homeDir}/.claude/settings.json:${homeDir}/.claude/settings.json:ro`,
        `${workspacePath}:/workspace`,
      ],
    };

    const services = (compose.services ?? {}) as Record<string, unknown>;
    services['agent'] = agentService;
    compose['services'] = services;

    fs.writeFileSync(composePath, yaml.dump(compose, { lineWidth: -1 }), 'utf-8');
  }

  /**
   * Create the agent workspace symlink and upsert the config.json entry.
   * Idempotent — safe to call multiple times (reconcile, reinstall).
   */
  async upsertAgent(entry: AppEntry): Promise<void> {
    if (!entry.agentDeclaration) return;

    const { name: agentName, path: agentRelPath } = entry.agentDeclaration;
    const workspaceLink = path.join(this.agentsDir, agentName, 'workspace');
    const targetDir = path.join(entry.installPath, agentRelPath);

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(workspaceLink), { recursive: true });

    // Remove stale symlink / file before recreating (force is a no-op if not present)
    fs.rmSync(workspaceLink, { force: true });
    fs.symlinkSync(targetDir, workspaceLink);

    const claudeBin = entry.agentPaths?.claudeBin ?? 'claude';

    await this.upsertConfigEntry(agentName, {
      id: agentName,
      type: 'app-agent',
      description: `Agent for app ${entry.name}`,
      container: `${entry.name}-agent`,
      claudeBin,
      workspace: workspaceLink,
      env: '',
      claude: {
        model: 'claude-sonnet-4-6',
        dangerouslySkipPermissions: true,
        extraFlags: [],
      },
    });
  }

  /**
   * Remove the workspace symlink and the config.json entry for an app-agent.
   */
  async deleteAgent(entry: AppEntry): Promise<void> {
    if (!entry.agentDeclaration) return;
    const { name: agentName } = entry.agentDeclaration;

    const workspaceLink = path.join(this.agentsDir, agentName, 'workspace');
    fs.rmSync(workspaceLink, { force: true });

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
    const memPath = path.join(this.agentsDir, agentName, 'workspace', 'MEMORY.md');
    try {
      return fs.readFileSync(memPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Write MEMORY.md back after a successful update.
   */
  restoreMemory(agentName: string, content: string): void {
    const memPath = path.join(this.agentsDir, agentName, 'workspace', 'MEMORY.md');
    fs.writeFileSync(memPath, content, 'utf-8');
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
      config.agents = config.agents.filter((a) => a['id'] !== agentId);
      this.writeConfig(config);
    });
  }
}
