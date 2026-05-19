import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import { AgentManager } from '../../../src/apps/agent-manager';
import { AppsRegistry, AppEntry } from '../../../src/apps/registry';

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
    ports: [{ name: 'api', service: 'app', containerPort: 5000, type: 'api', rateLimit: 60 }],
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
    manager = makeManager(tmpDir);
  });

  afterEach(() => {
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
      expect(agentSvc['image']).toBe('debian:stable-slim');
      expect(agentSvc['command']).toBe('sleep infinity');
      expect(agentSvc['container_name']).toBe('my-app-agent');
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

    it('injects correct volumes into agent service', () => {
      const entry = makeEntry(tmpDir);
      manager.injectAgentService(entry);

      const composePath = path.join(entry.installPath, 'docker-compose.yml');
      const composed = yaml.load(fs.readFileSync(composePath, 'utf-8')) as Record<string, unknown>;
      const services = composed['services'] as Record<string, unknown>;
      const agentSvc = services['agent'] as Record<string, unknown>;
      const volumes = agentSvc['volumes'] as string[];

      expect(volumes.some((v) => v.includes('/usr/local/bin/claude'))).toBe(true);
      expect(volumes.some((v) => v.includes('/workspace'))).toBe(true);
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
    it('creates a workspace symlink', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(true);
      expect(fs.lstatSync(workspaceLink).isSymbolicLink()).toBe(true);
    });

    it('symlink points to correct target', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      const target = fs.readlinkSync(workspaceLink);
      expect(target).toBe(path.join(entry.installPath, './agent'));
    });

    it('writes agent entry to config.json', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const agentEntry = config.agents.find((a) => a['id'] === 'my-agent');
      expect(agentEntry).toBeDefined();
      expect(agentEntry!['type']).toBe('app-agent');
      expect(agentEntry!['container']).toBe('my-app-agent');
      expect(agentEntry!['claudeBin']).toBe('/usr/local/bin/claude');
    });

    it('is idempotent — calling twice does not duplicate entry', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);
      manager.upsertAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      const matching = config.agents.filter((a) => a['id'] === 'my-agent');
      expect(matching).toHaveLength(1);
    });

    it('updates symlink if it already exists', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);

      // Create new agent source path
      const newAgentDir = path.join(entry.installPath, 'agent-v2');
      fs.mkdirSync(newAgentDir);
      const updatedEntry = { ...entry, agentDeclaration: { path: './agent-v2', name: 'my-agent' } };
      manager.upsertAgent(updatedEntry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      const target = fs.readlinkSync(workspaceLink);
      expect(target).toBe(path.join(entry.installPath, './agent-v2'));
    });

    it('is a no-op when agentDeclaration is null', () => {
      const entry = makeEntry(tmpDir);
      const noAgentEntry = { ...entry, agentDeclaration: null };
      manager.upsertAgent(noAgentEntry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(false);
    });
  });

  // ─── deleteAgent() ────────────────────────────────────────────────────────

  describe('deleteAgent()', () => {
    it('removes the workspace symlink', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
      expect(fs.existsSync(workspaceLink)).toBe(true);

      manager.deleteAgent(entry);
      expect(fs.existsSync(workspaceLink)).toBe(false);
    });

    it('removes the config.json entry', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);
      manager.deleteAgent(entry);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as {
        agents: Array<Record<string, unknown>>;
      };
      expect(config.agents.find((a) => a['id'] === 'my-agent')).toBeUndefined();
    });

    it('is a no-op for entry without agentDeclaration', () => {
      const entry = makeEntry(tmpDir);
      const noAgentEntry = { ...entry, agentDeclaration: null };
      expect(() => manager.deleteAgent(noAgentEntry)).not.toThrow();
    });

    it('is a no-op when symlink does not exist', () => {
      const entry = makeEntry(tmpDir);
      expect(() => manager.deleteAgent(entry)).not.toThrow();
    });
  });

  // ─── findAgentByName() ────────────────────────────────────────────────────

  describe('findAgentByName()', () => {
    it('returns null when agent is not registered', () => {
      expect(manager.findAgentByName('nonexistent')).toBeNull();
    });

    it('returns the agentId when registered', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);
      expect(manager.findAgentByName('my-agent')).toBe('my-agent');
    });

    it('returns null after deleteAgent', () => {
      const entry = makeEntry(tmpDir);
      manager.upsertAgent(entry);
      manager.deleteAgent(entry);
      expect(manager.findAgentByName('my-agent')).toBeNull();
    });
  });

  // ─── reconcileAgents() ────────────────────────────────────────────────────

  describe('reconcileAgents()', () => {
    it('upserts agent for running app with agentDeclaration', async () => {
      const registryPath = path.join(tmpDir, 'apps.json');
      const registry = new AppsRegistry(registryPath);
      const entry = makeEntry(tmpDir);
      await registry.upsert(entry);

      await manager.reconcileAgents(registry);

      const workspaceLink = path.join(tmpDir, 'agents', 'my-agent', 'workspace');
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
  });
});
