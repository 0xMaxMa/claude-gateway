import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { AppsRegistry, AppEntry } from './registry';
import { pathWithNativeBin } from '../session/claude-bin';
import { agentsDirForConfig } from '../config/agent-env';
import { withConfigWriteLock, writeConfigAtomicSync } from '../config/config-write-lock';

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
// Derived, not declared independently: the agents dir is always config.json's
// sibling, and the two must not be able to drift apart.
const DEFAULT_AGENTS_DIR = agentsDirForConfig(DEFAULT_CONFIG_PATH);

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  constructor(
    private readonly configPath: string = DEFAULT_CONFIG_PATH,
    private readonly agentsDir: string = DEFAULT_AGENTS_DIR,
  ) {}

  /**
   * Serialises config reads/writes against every other writer of the same file —
   * the agents API and the connectors store included, not just other AgentManager
   * calls. See config/config-write-lock.ts for why an instance-private lock was
   * not enough.
   */
  private withConfigLock<T>(fn: () => T): Promise<T> {
    return withConfigWriteLock(this.configPath, fn);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Detect host binary paths for injection into the agent container.
   * Runs once at install time; results stored in apps.json.
   *
   * The PATH is hardened with the native-installer bin dir before probing, the
   * same way process.ts hardens a spawned child's PATH. Without it, execSync
   * inherits the gateway's own PATH — under systemd that omits ~/.local/bin, so
   * `which claude` misses the native install and can return a compat wrapper
   * script instead. Mounting that wrapper into the container is fatal: it only
   * re-probes host paths that were never mounted, so it exits 1 on every turn.
   */
  detectAgentPaths(): AgentPaths {
    const hardenedPath = pathWithNativeBin();
    const run = (cmd: string): string =>
      execSync(cmd, {
        encoding: 'utf-8',
        env: { ...process.env, ...(hardenedPath ? { PATH: hardenedPath } : {}) },
      }).toString().trim();

    const claudeBin = run('which claude');
    const realClaudeBin = fs.realpathSync(claudeBin);
    const nodeBin = fs.realpathSync(run('which node'));
    const npmRoot = run('npm root -g');

    return { claudeBin: realClaudeBin, nodeBin, npmRoot };
  }

  /**
   * Stage the host's ~/.claude.json into a gateway-owned seed directory for one
   * agent, and report where it landed.
   *
   * The seed is a DIRECTORY, never the host file itself. A Docker *file* bind
   * mount pins an inode rather than a path, so an atomic rewrite on the host
   * allocates a new inode and leaves the container reading the old, unlinked one
   * for the rest of its life. Claude Code rewrites ~/.claude.json exactly that
   * way, so mounting it directly meant the container's view froze at the first
   * rewrite and never recovered. A directory mount resolves its entries per
   * access, so re-staging the file is enough — the container picks it up on its
   * next (re)start with no recreate.
   *
   * Called from injectAgentService (install/update/reconfigure) and from
   * upsertAgent, which reconcileAgents runs for every app-agent at gateway
   * start. Without the second call site the seed would only ever refresh when
   * the app itself was touched, so a host `claude /login` under a different
   * account could stay invisible to containers indefinitely.
   *
   * Mode is set explicitly because mkdir/copyFile modes are umask-dependent: the
   * seed is a copy of the host's Claude config and must not be world-readable,
   * even though the host file itself is commonly 0644.
   *
   * The copy is staged through a temp file and renamed into place — the same
   * write-then-rename idiom writeConfig() uses below. A container runs `cp` on
   * this file at its own start, which can land mid-copy on a gateway restart;
   * rename makes the container see either the old file or the new one, never a
   * half-written config. Rename is safe here precisely because the *directory*
   * is what gets mounted: entries resolve per access, which is the property this
   * whole seed mechanism relies on.
   */
  private stageClaudeSeed(agentName: string): { seedSource: string; seeded: boolean } {
    const seedDir = path.join(this.agentsDir, agentName, '.claude-seed');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.chmodSync(seedDir, 0o700);

    const hostClaudeJson = path.join(os.homedir(), '.claude.json');
    let seeded = false;
    if (fs.existsSync(hostClaudeJson)) {
      const dest = path.join(seedDir, '.claude.json');
      const tmp = `${dest}.tmp.${process.pid}`;
      try {
        fs.copyFileSync(hostClaudeJson, tmp);
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, dest);
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
        throw err;
      }
      seeded = true;
    }
    return { seedSource: fs.realpathSync(seedDir), seeded };
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
    // replaced via rename, regardless of ro/rw), so the container needs a writable
    // *copy* rather than a mount: we stage a gateway-owned seed and copy out of it
    // at container start (see `command` below).
    //
    // The copy targets the literal homeDir: container-start HOME is `/`, but the
    // gateway runs turns with `docker exec -e HOME=<homeDir>` (see process.ts).
    const containerSeedDir = `${homeDir}/.claude-seed`;
    const { seedSource, seeded: seededClaudeJson } = this.stageClaudeSeed(agentName);

    // ~/.claude/settings.json is deliberately NOT mounted. On the host it exists
    // to carry credentials, and mounting that file is exactly what broke container
    // agents (stale inode after an atomic host rewrite). Credentials now reach the
    // container as `docker exec -e` env resolved from the live host file on every
    // session spawn (see resolveContainerAuthEnv in session/process.ts), which
    // also lets an already-broken container recover without being recreated.
    //
    // The file's remaining keys are host-scoped: enabledPlugins and
    // extraKnownMarketplaces point at paths that were never mounted into the
    // container, and skipDangerousModePermissionPrompt only suppresses the
    // interactive bypass dialog, which a container agent never sees — app-agents
    // are forced onto the headless backend, and headless always passes
    // --dangerously-skip-permissions.

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

    // Seed a writable ~/.claude.json from the read-only seed mount, then idle.
    // The copy re-runs on every (re)start, and because the seed is a directory
    // mount it resolves the *current* staged file rather than a pinned inode.
    // Steps are `;`-separated, not `&&`: a failed copy must surface on stderr
    // (visible in `docker logs`) without preventing the container from starting.
    // `exec` keeps the container's PID 1 as sleep.
    //
    // Paths are double-quoted inside the single-quoted `sh -c` argument: homeDir
    // is host-derived and may contain spaces, which would otherwise split into
    // extra `cp` operands and copy the config to the wrong place.
    const seedCopy = seededClaudeJson
      ? `cp "${containerSeedDir}/.claude.json" "${homeDir}/.claude.json"; `
      : '';

    const agentService = {
      build: { context: entry.installPath, dockerfile: 'Dockerfile.agent' },
      user: `${uid}:${uid}`,
      command: `sh -c '${seedCopy}exec sleep infinity'`,
      container_name: `${entry.name}-agent`,
      restart: 'unless-stopped',
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges'],
      env_file: '.env',
      volumes: [
        `${claudeBin}:${claudeBin}:ro`,
        `${nodeBin}:/usr/bin/node:ro`,
        `${npmRoot}:${npmRoot}:ro`,
        `${seedSource}:${containerSeedDir}:ro`,
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

    // Refresh the staged Claude config from the host. reconcileAgents() calls
    // this for every running app-agent at gateway start, so the staged copy
    // tracks the host without waiting for the app to be reinstalled or updated.
    //
    // Refreshing the seed is not the same as refreshing a container: the copy
    // into the container runs in its start command, and nothing here restarts
    // containers (composeUp is only called from the installer). With
    // `restart: unless-stopped` they outlive a gateway restart, so a container
    // already running picks the new seed up at its next start, not at ours.
    // Credentials do not depend on this — they are forwarded per session spawn
    // by resolveContainerAuthEnv() — so the lag only affects the rest of
    // ~/.claude.json. Agents installed before the seed directory existed keep
    // their old compose until the app is updated, and ignore it entirely.
    //
    // Best-effort: a failure here must not stop the agent from being
    // registered, since the container falls back to the previously staged copy.
    try {
      this.stageClaudeSeed(agentName);
    } catch { /* keep the existing seed */ }

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
   * Removes the workspace symlink and the re-stageable Claude config seed;
   * preserves sessions/ and other data so that a reinstall picks up the same
   * conversation history.
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
    // The Claude config seed is derived data, not history: it is re-staged from
    // the host on the next install/update, so an app that has been removed must
    // not leave a copy of the host's Claude config sitting on disk. The rest of
    // the agent dir (sessions, media) is deliberately preserved.
    //
    // No isSymbolicLink() guard here, unlike the workspace link above: rmSync
    // does not traverse a symlink even with recursive, it unlinks the link
    // itself, so a symlink standing at this path cannot lead the delete outside
    // the agent dir. The workspace guard exists for a different reason — that
    // path may legitimately hold a *user* agent's real workspace.
    try {
      fs.rmSync(path.join(this.agentsDir, agentName, '.claude-seed'), {
        recursive: true,
        force: true,
      });
    } catch { /* best-effort */ }
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
    // mode: 0o700 — same secret-bearing directory bootstrap.ts creates; this
    // mkdirSync is usually a recursive no-op once that's already run, but
    // must not itself default to 0755 on any path that reaches here first.
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    writeConfigAtomicSync(this.configPath, config);
  }

  private async upsertConfigEntry(agentId: string, entry: Record<string, unknown>): Promise<void> {
    return this.withConfigLock(() => {
      const config = this.readConfig();
      const idx = config.agents.findIndex((a) => a['id'] === agentId);
      if (idx >= 0) {
        // Merge — never replace. `entry` carries only the app-managed fields
        // rebuilt from the app declaration (id/type/container/claudeBin/workspace/…);
        // spreading it over the existing entry refreshes those while preserving
        // any operator-added keys — crucially the `line`/`telegram`/`discord`
        // channel blocks configured after install. A full replace here wiped
        // those on every reconcile/restart, silently disconnecting the channel.
        config.agents[idx] = { ...config.agents[idx], ...entry };
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
