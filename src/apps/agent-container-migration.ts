import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import type { AgentManager } from './agent-manager';
import type { AppsRegistry, AppEntry } from './registry';
import { claudeSettingsPath } from '../config/claude-settings';
import { validateContainerInspection } from '../orchestration/container';

export type DockerCommand = (args: string[], cwd: string) => Promise<string>;
const docker: DockerCommand = async (args, cwd) => {
  const result = await promisify(execFile)('docker', args, {cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024});
  return result.stdout;
};

/** Only installer-owned legacy credential mounts qualify; unknown mounts still fail admission. */
export async function migrateAppAgentContainer(entry: AppEntry, agent: AgentConfig, manager: Pick<AgentManager, 'injectAgentService'>, run: DockerCommand = docker): Promise<boolean> {
  if (!agent.orchestration?.enabled || agent.type !== 'app-agent' || entry.status !== 'running' || !entry.agentDeclaration || !entry.agentPaths) return false;
  if (entry.agentDeclaration.name !== agent.id || agent.container !== `${entry.name}-agent`) throw new Error('CONTAINER_MIGRATION_IDENTITY_MISMATCH');
  const inspect = JSON.parse(await run(['inspect', agent.container], entry.installPath))[0];
  const labels = inspect.Config?.Labels ?? {};
  if (labels['com.docker.compose.service'] !== 'agent' || labels['com.docker.compose.project'] !== entry.name ||
      realpathSync(labels['com.docker.compose.project.working_dir'] || '/') !== realpathSync(entry.installPath)) throw new Error('CONTAINER_MIGRATION_OWNERSHIP_REQUIRED');
  const oldSources = new Set([join(homedir(), '.claude', 'settings.json'), claudeSettingsPath()]);
  const legacy = (m: any) => m.Type === 'bind' && !m.RW && (
    (oldSources.has(m.Source) && m.Destination === join(homedir(), '.claude', 'settings.json')) ||
    (m.Source === join(homedir(), '.claude.json') && m.Destination === join(homedir(), '.claude.json.seed')));
  if (!(inspect.Mounts ?? []).some(legacy)) return false;
  // Validate all other mounts and privileges before changing anything. Do not
  // turn an arbitrary/privileged container into an implicitly approved one.
  await validateContainerInspection(agent, {...inspect, Mounts: inspect.Mounts.filter((m: any) => !legacy(m))});
  const compose = join(entry.installPath, 'docker-compose.yml');
  const dockerfile = join(entry.installPath, 'Dockerfile.agent');
  const previous = readFileSync(compose);
  const previousDockerfile = existsSync(dockerfile) ? readFileSync(dockerfile) : undefined;
  const backup = join(entry.installPath, '.gateway-agent-migrations', randomUUID());
  mkdirSync(backup, {recursive: true, mode: 0o700});
  copyFileSync(compose, join(backup, 'docker-compose.yml'));
  if (previousDockerfile) copyFileSync(dockerfile, join(backup, 'Dockerfile.agent'));
  try {
    manager.injectAgentService(entry);
    // Existing image already has the CLI runtime/home. Recreate ONLY agent:
    // no app/db restart, dependency traversal, image rebuild or volume removal.
    await run(['compose', '-p', entry.name, '-f', compose, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'agent'], entry.installPath);
    const updated = JSON.parse(await run(['inspect', agent.container], entry.installPath))[0];
    await validateContainerInspection(agent, updated);
    return true;
  } catch (error) {
    writeFileSync(compose, previous);
    if (previousDockerfile) writeFileSync(dockerfile, previousDockerfile);
    // Do not recreate the rejected legacy mounts as a rollback. Admission stays
    // closed; the durable backup remains available for explicit recovery.
    throw error;
  }
}

export async function migrateAppAgentContainers(registry: Pick<AppsRegistry, 'list'>, manager: Pick<AgentManager, 'injectAgentService'>, agents: AgentConfig[]): Promise<Array<{app: string; error: string}>> {
  const errors: Array<{app: string; error: string}> = [];
  let entries: AppEntry[];
  try { entries = await registry.list(); }
  catch { return [{app: 'registry', error: 'APP_REGISTRY_UNAVAILABLE'}]; }
  for (const entry of entries) {
    const agent = agents.find(a => a.id === entry.agentDeclaration?.name);
    if (!agent) continue;
    try { await migrateAppAgentContainer(entry, agent, manager); }
    catch (error) { errors.push({app: entry.name, error: error instanceof Error ? error.message : 'CONTAINER_MIGRATION_FAILED'}); }
  }
  return errors;
}
