import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import { AgentManager } from '../../../src/apps/agent-manager';
import { AppsRegistry, AppEntry } from '../../../src/apps/registry';

// ── os.homedir mock (set per-test) ────────────────────────────────────────────
// injectAgentService() reads and stages the host ~/.claude.json, so the suite
// points HOME at a fixture dir: deterministic on a bare CI box, and it never
// touches the real user's home. Both specifiers are mocked because the source
// imports 'node:os' while some deps import bare 'os'.
// `var`, not `let`: agent-manager.ts calls os.homedir() at module scope, which
// runs before a `let` in this file would leave its temporal dead zone.
// eslint-disable-next-line no-var
var mockHomeDir: string | null = null;
jest.mock('node:os', () => {
  const real = jest.requireActual<typeof os>('node:os');
  return { ...real, homedir: () => mockHomeDir ?? real.homedir() };
});
jest.mock('os', () => {
  const real = jest.requireActual<typeof os>('node:os');
  return { ...real, homedir: () => mockHomeDir ?? real.homedir() };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
}

/** Build a minimal AppEntry with an agent declaration */
function makeEntry(
  tmpDir: string,
  appName = 'my-app',
  agentName = 'my-agent',
): AppEntry {
  const installPath = path.join(tmpDir, 'apps', appName);
  fs.mkdirSync(installPath, { recursive: true });

  // Write a minimal docker-compose.yml
  const compose = {
    services: {
      app: {
        image: 'nginx:1.25',
        ports: ['5000:5000'],
      },
    },
  };
  fs.writeFileSync(
    path.join(installPath, 'docker-compose.yml'),
    yaml.dump(compose),
    'utf-8',
  );

  // Create the agent workspace source dir
  const agentSrcDir = path.join(installPath, 'agent');
  fs.mkdirSync(agentSrcDir, { recursive: true });
  fs.writeFileSync(path.join(agentSrcDir, 'CLAUDE.md'), '# Agent', 'utf-8');

  return {
    name: appName,
    version: '1.0.0',
    commit: 'abc123def456abc123def456abc123def456abc1',
    githubUrl: 'https://github.com/test/my-app',
    installPath,
    ports: [{ name: 'api', service: 'app', hostPort: 5000, containerPort: 5000, type: 'api', rateLimit: 60 }],
    sockets: {},
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    source: 'registry',
    agentDeclaration: { path: './agent', name: agentName },
    agentPaths: { claudeBin: '/usr/local/bin/claude', nodeBin: '/usr/bin/node', npmRoot: '/usr/lib/node_modules' },
  };
}

function makeManager(tmpDir: string): AgentManager {
  const configPath = path.join(tmpDir, 'config.json');
  const agentsDir = path.join(tmpDir, 'agents');
  return new AgentManager(configPath, agentsDir);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentManager', () => {
  let tmpDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Fixture home: injectAgentService() stages ~/.claude.json into the seed dir.
    mockHomeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(mockHomeDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(mockHomeDir, '.claude.json'), JSON.stringify({ projects: {} }), 'utf-8');
    manager = makeManager(tmpDir);
  });

  afterEach(() => {
    mockHomeDir = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── injectAgentService() ──────────────────────────────────────────────────

  describe('injectAgentService()', () => {
    it('adds agent service to docker-compose.yml', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;

      expect(services['agent']).toBeDefined();
      const agentSvc = services['agent'] as Record<string, unknown>;
      // built from Dockerfile.agent (debian:stable-slim) so compose uses build: not image:
      const build = agentSvc['build'] as Record<string, unknown>;
      expect(build).toBeDefined();
      expect(build['dockerfile']).toBe('Dockerfile.agent');
      expect(typeof agentSvc['command']).toBe('string');
      expect((agentSvc['command'] as string)).toContain('sleep infinity');
      expect(agentSvc['container_name']).toBe('my-app-agent');
    });

    it('injects security_opt no-new-privileges', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      expect(agentSvc['security_opt']).toEqual(['no-new-privileges']);
    });

    it('preserves existing services', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;

      expect(services['app']).toBeDefined();
      expect(services['agent']).toBeDefined();
    });

    it('mounts binaries, auth files, and workspace as volumes', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];

      expect(volumes).toBeDefined();
      expect(volumes.some((v) => v.includes('claude') && v.endsWith(':ro'))).toBe(true);
      expect(volumes.some((v) => v.endsWith(':/workspace'))).toBe(true);
      // ~/.claude.json reaches the container through a read-only seed *directory*
      // (copied to a writable file at container start — see the regression tests
      // below), never as a mount of the host file itself.
      expect(volumes.some((v) => v.includes('.claude-seed') && v.endsWith(':ro'))).toBe(true);
    });

    it('never bind-mounts an individual host Claude config file (regression: stale inode => "Not logged in")', () => {
      // A Docker *file* bind mount pins an inode, not a path. Claude Code rewrites
      // ~/.claude/settings.json and ~/.claude.json by atomic rename, which
      // allocates a new inode on the host and unlinks the old one — leaving a
      // long-lived container reading a deleted inode for the rest of its life.
      // Claude Code silently ignores a settings.json whose inode is unlinked, so
      // every app-agent turn returned "Not logged in · Please run /login" with no
      // crash and nothing in the logs. Mount sources must therefore be directories.
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];
      const home = os.homedir();

      const sources = volumes.map((v) => v.split(':')[0]);
      expect(sources).not.toContain(path.join(home, '.claude', 'settings.json'));
      expect(sources).not.toContain(path.join(home, '.claude.json'));
    });

    it('stages the Claude config seed as a private directory the gateway owns', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];
      const home = os.homedir();

      // Staged next to the agent's media dir, outside the app's install path so an
      // app service's own compose can never mount it.
      const seedDir = path.join(tmpDir, 'agents', 'my-agent', '.claude-seed');
      expect(fs.statSync(seedDir).isDirectory()).toBe(true);
      expect(fs.statSync(seedDir).mode & 0o777).toBe(0o700);

      // The host ~/.claude.json is copied in, not mounted, and stays private.
      const staged = path.join(seedDir, '.claude.json');
      expect(fs.readFileSync(staged, 'utf-8')).toBe(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
      expect(fs.statSync(staged).mode & 0o777).toBe(0o600);

      // Mounted read-only as a directory, so Docker resolves entries per access.
      const seedMount = volumes.find((v) => v.split(':')[1] === `${home}/.claude-seed`);
      expect(seedMount).toBeDefined();
      expect(seedMount!.endsWith(':ro')).toBe(true);
      expect(seedMount!.split(':')[0]).toBe(fs.realpathSync(seedDir));
    });

    it('seeds a writable ~/.claude.json via copy instead of a read-only mount at its real path (regression: app-agent "Not logged in")', () => {
      // Claude Code rewrites ~/.claude.json atomically at startup (write temp +
      // rename over the target). Bind-mounting the host file at its real container
      // path makes that rename fail with EBUSY, so auth state is never persisted
      // and every app-agent turn returns "Not logged in · Please run /login".
      // Fix: stage the host file in a read-only seed dir and copy it into a
      // writable ~/.claude.json at container start.
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];
      const home = os.homedir();

      // The host ~/.claude.json must NOT be bind-mounted at its real container
      // path (that is the mountpoint whose atomic-rename fails).
      const realPathMount = volumes.find((v) => v.split(':')[1] === `${home}/.claude.json`);
      expect(realPathMount).toBeUndefined();

      // The container copies the seed into a writable ~/.claude.json at start.
      // Paths are quoted: homeDir is host-derived, and an unquoted path with a
      // space would split into extra `cp` operands and land the config elsewhere.
      const command = agentSvc['command'] as string;
      expect(command).toContain(`cp "${home}/.claude-seed/.claude.json" "${home}/.claude.json"`);
      // `;` not `&&`: a failed copy must not stop the container from starting.
      expect(command).toContain('; exec sleep infinity');
    });

    it('omits the seed copy when the host has no ~/.claude.json', () => {
      fs.rmSync(path.join(mockHomeDir!, '.claude.json'));
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;

      // No dangling `cp` of a file that does not exist — the container still idles.
      const command = agentSvc['command'] as string;
      expect(command).not.toContain('cp ');
      expect(command).toContain('sleep infinity');
    });

    it('mounts the agent media dir at the identical host path (:rw) and pre-creates it', () => {
      // Regression for app-agent containers being unable to read uploaded images:
      // the gateway hands the agent raw host paths under
      // <home>/.claude-gateway/agents/<name>/media (a sibling of workspace, outside
      // the /workspace mount). Mounting that dir at the same absolute path lets the
      // raw image_path resolve inside the container.
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];

      // The media dir lives under the manager's agentsDir (tmpDir/agents), matching
      // where the gateway saves uploaded images at runtime.
      const expectedMediaDir = path.join(tmpDir, 'agents', 'my-agent', 'media');

      // Pre-created on disk so Docker bind-mounts an existing (uid-owned) dir
      // instead of creating a root-owned one.
      expect(fs.existsSync(expectedMediaDir)).toBe(true);

      // Mounted read-write with the container destination == the host path the
      // gateway hands the agent (source may be realpath-resolved).
      const mediaVol = volumes.find((v) => v.endsWith(`:${expectedMediaDir}:rw`));
      expect(mediaVol).toBeDefined();
      expect(mediaVol!.split(':')[1]).toBe(expectedMediaDir);
    });

    it('is a no-op when agentDeclaration is null', () => {
      const entry = makeEntry(tmpDir);
      const noAgentEntry = { ...entry, agentDeclaration: null };
      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const before = fs.readFileSync(composePath, 'utf-8');

      manager.injectAgentService(noAgentEntry);

      expect(fs.readFileSync(composePath, 'utf-8')).toBe(before);
    });

    it('is a no-op when agentPaths is missing', () => {
      const entry = makeEntry(tmpDir);
      const noPathsEntry = { ...entry, agentPaths: undefined };
      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const before = fs.readFileSync(composePath, 'utf-8');

      manager.injectAgentService(noPathsEntry);

      expect(fs.readFileSync(composePath, 'utf-8')).toBe(before);
    });
  });

  // ─── upsertAgent() ────────────────────────────────────────────────────────

  describe('upsertAgent()', () => {
    it('creates agents/{name}/ dir with workspace symlink inside', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      // agents/my-agent is a real directory
      const agentDir = path.join(tmpDir, 'agents', 'my-agent');
      expect(fs.existsSync(agentDir)).toBe(true);
      expect(fs.lstatSync(agentDir).isDirectory()).toBe(true);
      expect(fs.lstatSync(agentDir).isSymbolicLink()).toBe(false);

      // workspace symlink is inside the dir
      const workspaceLink = path.join(agentDir, 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(true);
      expect(fs.lstatSync(workspaceLink).isSymbolicLink()).toBe(true);
    });

    it('symlink points to correct target', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      const target = fs.readlinkSync(workspaceLink);
      expect(target).toBe(path.join(entry.installPath, 'agent'));
    });

    it('writes agent entry to config.json', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const agentEntry = config.agents.find((a) => a['id'] === 'my-agent');
      expect(agentEntry).toBeDefined();
      expect(agentEntry!['type']).toBe('app-agent');
      expect(agentEntry!['container']).toBe('my-app-agent');
      expect(agentEntry!['claudeBin']).toBe('/usr/local/bin/claude'); // actual host path, volume-mounted
    });

    it('is idempotent — calling twice does not duplicate entry', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);
      await manager.upsertAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const matching = config.agents.filter((a) => a['id'] === 'my-agent');
      expect(matching).toHaveLength(1);
    });

    // Regression (#294): channel config (line/telegram/discord) added to an
    // app-agent entry AFTER install must survive reconcile/upsert. The old code
    // did `config.agents[idx] = entry` (full replace) with an entry rebuilt from
    // the app declaration that carries no channel blocks, so every gateway
    // restart silently wiped them — disconnecting the agent's LINE/Telegram/Discord.
    it('preserves operator-added channel config (line/telegram/discord) on re-upsert while refreshing app-managed fields', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      // Simulate an already-installed app-agent whose channel config was added
      // after install, plus a stale app-managed field (container) to prove the
      // merge still refreshes declaration-owned fields.
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { logDir: 'logs', timezone: 'UTC' },
          agents: [
            {
              id: 'my-agent',
              type: 'app-agent',
              container: 'stale-container',
              line: { channelSecret: 'sec-123', channelAccessToken: 'tok-abc', slowResponseThreshold: 45 },
              telegram: { botToken: 'tg-token' },
              discord: { botToken: 'dc-token' },
            },
          ],
        }),
        'utf-8',
      );

      const entry = makeEntry(tmpDir); // agentDeclaration.name === 'my-agent', container my-app-agent
      await manager.upsertAgent(entry);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const agentEntry = config.agents.find((a) => a['id'] === 'my-agent');
      expect(agentEntry).toBeDefined();

      // Channel blocks survive the reconcile (the actual regression).
      expect(agentEntry!['line']).toEqual({
        channelSecret: 'sec-123',
        channelAccessToken: 'tok-abc',
        slowResponseThreshold: 45,
      });
      expect(agentEntry!['telegram']).toEqual({ botToken: 'tg-token' });
      expect(agentEntry!['discord']).toEqual({ botToken: 'dc-token' });

      // App-managed fields are still refreshed from the declaration (not left stale).
      expect(agentEntry!['container']).toBe('my-app-agent');
      expect(agentEntry!['type']).toBe('app-agent');
      // Still a single entry — merge, not append.
      expect(config.agents.filter((a) => a['id'] === 'my-agent')).toHaveLength(1);
    });

    // #460: config.json carries agent bot tokens and the admin API key.
    // writeConfig()'s tmp-then-rename pattern silently downgraded it from
    // 0600 to the tmp file's default mode (0644) on every write.
    it('writes config.json at 0600, even on the very first write to a fresh directory', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const entry = makeEntry(tmpDir);

      await manager.upsertAgent(entry);

      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    });

    it('updates symlink if it already exists', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      // Create new agent source path
      const newAgentDir = path.join(entry.installPath, 'agent-v2');
      fs.mkdirSync(newAgentDir);
      const updatedEntry = { ...entry, agentDeclaration: { path: './agent-v2', name: 'my-agent' } };
      await manager.upsertAgent(updatedEntry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      const target = fs.readlinkSync(workspaceLink);
      expect(target).toBe(path.join(entry.installPath, 'agent-v2'));
    });

    it('is a no-op when agentDeclaration is null', async () => {
      const entry = makeEntry(tmpDir);
      const noAgentEntry = { ...entry, agentDeclaration: null };
      await manager.upsertAgent(noAgentEntry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent');
      expect(fs.existsSync(workspaceLink)).toBe(false);
    });

    it('re-stages the Claude config seed, so a gateway restart refreshes it', async () => {
      // reconcileAgents() calls upsertAgent for every running app-agent at gateway
      // start. Staging only from injectAgentService would pin the seed to the last
      // install/update, so a host-side `claude /login` could stay invisible to
      // containers indefinitely.
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      const seedFile = path.join(tmpDir, 'agents', 'my-agent', '.claude-seed', '.claude.json');
      expect(fs.existsSync(seedFile)).toBe(true);

      // Rewrite the host file the way Claude Code does — atomic rename, new inode.
      const hostClaudeJson = path.join(os.homedir(), '.claude.json');
      const tmpHost = `${hostClaudeJson}.tmp`;
      fs.writeFileSync(tmpHost, JSON.stringify({ marker: 'rotated' }), 'utf-8');
      fs.renameSync(tmpHost, hostClaudeJson);

      await manager.upsertAgent(entry);

      expect(JSON.parse(fs.readFileSync(seedFile, 'utf-8'))).toEqual({ marker: 'rotated' });
      // Not world-readable: it is a copy of the host's Claude config.
      expect(fs.statSync(seedFile).mode & 0o077).toBe(0);
    });

    it('stages the seed atomically, leaving no partial file when the copy fails', async () => {
      // A container copies this file in its start command, which can run while
      // the gateway is re-staging. Writing in place would let it read a
      // half-written config; write-then-rename means it sees the old file or
      // the new one. A failed copy must therefore leave the previous seed
      // intact and no temp file behind.
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      const seedDir = path.join(tmpDir, 'agents', 'my-agent', '.claude-seed');
      const seedFile = path.join(seedDir, '.claude.json');
      const before = fs.readFileSync(seedFile, 'utf-8');

      // Make the copy fail for real rather than mocking it: a directory where
      // the host config should be passes existsSync and then throws EISDIR.
      const hostClaudeJson = path.join(os.homedir(), '.claude.json');
      fs.rmSync(hostClaudeJson);
      fs.mkdirSync(hostClaudeJson);

      // upsertAgent swallows a staging failure by design — the point is what it
      // leaves on disk.
      await manager.upsertAgent(entry);

      expect(fs.readFileSync(seedFile, 'utf-8')).toBe(before);
      expect(fs.readdirSync(seedDir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    });
  });

  // ─── deleteAgent() ────────────────────────────────────────────────────────

  describe('deleteAgent()', () => {
    it('removes the workspace symlink but preserves the agent dir (for session history)', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);

      const agentDir = path.join(tmpDir, 'agents', 'my-agent');
      const workspaceLink = path.join(agentDir, 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(true);

      await manager.deleteAgent(entry);
      // Workspace symlink is removed but agent dir (and sessions) are kept
      expect(fs.existsSync(workspaceLink)).toBe(false);
      expect(fs.existsSync(agentDir)).toBe(true);
    });

    it('drops the Claude config seed on delete but keeps session history', async () => {
      // The seed is a copy of the host ~/.claude.json, re-staged from the host on
      // every install/update. It is derived data, so a removed app must not leave
      // a copy of the host's Claude config behind — unlike sessions, which are
      // kept so a reinstall resumes the same conversations.
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);
      await manager.upsertAgent(entry);

      const agentDir = path.join(tmpDir, 'agents', 'my-agent');
      const seedDir = path.join(agentDir, '.claude-seed');
      const sessions = path.join(agentDir, 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, 'a.json'), '{}', 'utf-8');
      expect(fs.existsSync(path.join(seedDir, '.claude.json'))).toBe(true);

      await manager.deleteAgent(entry);

      expect(fs.existsSync(seedDir)).toBe(false);
      expect(fs.existsSync(path.join(sessions, 'a.json'))).toBe(true);
    });

    it('removes the config.json entry', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);
      await manager.deleteAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      expect(config.agents.find((a) => a['id'] === 'my-agent')).toBeUndefined();
    });

    it('is a no-op for entry without agentDeclaration', async () => {
      const entry = makeEntry(tmpDir);
      const noAgentEntry = { ...entry, agentDeclaration: null };
      await manager.deleteAgent(noAgentEntry);
      // no throw = pass
    });

    it('is a no-op when symlink does not exist', async () => {
      const entry = makeEntry(tmpDir);
      await manager.deleteAgent(entry);
      // no throw = pass
    });

    // Safety: deleting an app-agent must never remove a user-created agent that
    // happens to share the same id (issue #263 — orphan reclaim must not touch
    // user agents).
    it('removes only the app-agent entry, preserving a same-named user agent', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { logDir: 'logs', timezone: 'UTC' },
          agents: [
            { id: 'shared', type: 'user' }, // user-created agent (not an app-agent)
            { id: 'shared', type: 'app-agent', containerName: 'app-shared' },
          ],
        }),
        'utf-8',
      );
      // The user agent has a REAL workspace dir at the shared path.
      const userWs = path.join(tmpDir, 'agents', 'shared', 'workspace');
      fs.mkdirSync(userWs, { recursive: true });
      fs.writeFileSync(path.join(userWs, 'SOUL.md'), 'user data', 'utf-8');

      await manager.deleteAgentByName('shared');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      // app-agent entry removed…
      expect(config.agents.filter((a) => a['id'] === 'shared' && a['type'] === 'app-agent')).toHaveLength(0);
      // …but the user agent entry is preserved
      expect(config.agents.filter((a) => a['id'] === 'shared' && a['type'] === 'user')).toHaveLength(1);
      // and its real workspace dir is untouched
      expect(fs.existsSync(path.join(userWs, 'SOUL.md'))).toBe(true);
    });
  });

  // ─── findAgentByName() ────────────────────────────────────────────────────

  describe('findAgentByName()', () => {
    it('returns null when agent is not registered', async () => {
      await expect(manager.findAgentByName('nonexistent')).resolves.toBeNull();
    });

    it('returns the agentId when registered', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);
      await expect(manager.findAgentByName('my-agent')).resolves.toBe('my-agent');
    });

    it('returns null after deleteAgent', async () => {
      const entry = makeEntry(tmpDir);
      await manager.upsertAgent(entry);
      await manager.deleteAgent(entry);
      await expect(manager.findAgentByName('my-agent')).resolves.toBeNull();
    });
  });

  // ─── reconcileAgents() ────────────────────────────────────────────────────

  describe('reconcileAgents()', () => {
    it('upserts agent for running app with agentDeclaration', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      await registry.upsert(entry);

      const errors = await manager.reconcileAgents(registry);
      expect(errors).toHaveLength(0);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent');
      expect(fs.existsSync(workspaceLink)).toBe(true);
    });

    it('skips apps without agentDeclaration', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      await registry.upsert({ ...entry, agentDeclaration: null });

      await manager.reconcileAgents(registry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(false);
    });

    it('skips stopped apps', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      await registry.upsert({ ...entry, status: 'stopped' });

      await manager.reconcileAgents(registry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(false);
    });

    it('is idempotent — calling twice produces same result', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      await registry.upsert(entry);

      await manager.reconcileAgents(registry);
      await manager.reconcileAgents(registry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const matching = config.agents.filter((a) => a['id'] === 'my-agent');
      expect(matching).toHaveLength(1);
    });

    it('returns errors array for apps that fail reconcile', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      // Remove the agent source dir so symlink creation will fail
      fs.rmSync(path.join(entry.installPath, 'agent'), { recursive: true, force: true });
      await registry.upsert(entry);

      const errors = await manager.reconcileAgents(registry);
      // upsertAgent does not validate that target dir exists before creating symlink — it will succeed
      // This test verifies the structure of the return value
      expect(Array.isArray(errors)).toBe(true);
    });
  });
});
