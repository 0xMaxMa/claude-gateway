import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { migrateAppAgentContainer } from '../../../src/apps/agent-container-migration';
import type { AgentConfig } from '../../../src/types';
import type { AppEntry } from '../../../src/apps/registry';

let root: string, agent: AgentConfig, entry: AppEntry, inspection: any;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-migration-'));
  mkdirSync(join(root, 'workspace')); mkdirSync(join(root, 'media'));
  writeFileSync(join(root, 'docker-compose.yml'), 'original compose');
  writeFileSync(join(root, 'workspace', 'MEMORY.md'), 'keep memory');
  agent = {id: 'app-bot', type: 'app-agent', container: 'app-agent', workspace: join(root, 'workspace'), orchestration: {enabled: true}} as AgentConfig;
  entry = {name:'app', status:'running', installPath:root, agentDeclaration:{name:'app-bot',path:'workspace'}, agentPaths:{}} as AppEntry;
  inspection = {State:{Running:true}, HostConfig:{CapDrop:['ALL'], SecurityOpt:['no-new-privileges'], NetworkMode:'app_default'},
    Config:{Labels:{'com.docker.compose.service':'agent','com.docker.compose.project':'app','com.docker.compose.project.working_dir':root}},
    Mounts:[{Type:'bind',Source:join(root,'workspace'),Destination:'/workspace',RW:true},
      {Type:'bind',Source:join(homedir(),'.claude','settings.json'),Destination:join(homedir(),'.claude','settings.json'),RW:false}]};
});
afterEach(() => rmSync(root,{recursive:true,force:true}));

test('migration recreates only the agent and leaves workspace intact; subsequent boots are no-ops', async () => {
  const injectAgentService=jest.fn(() => writeFileSync(join(root,'docker-compose.yml'),'new compose'));
  const run=jest.fn(async (args:string[]) => {
    if(args[0]==='compose'){ inspection.Mounts.pop(); return ''; }
    return JSON.stringify([inspection]);
  });
  expect(await migrateAppAgentContainer(entry,agent,{injectAgentService},run)).toBe(true);
  expect(run.mock.calls.find(([args])=>args[0]==='compose')?.[0]).toEqual(['compose','-p','app','-f',join(root,'docker-compose.yml'),'up','-d','--no-deps','--no-build','--force-recreate','agent']);
  expect(readFileSync(join(root,'workspace','MEMORY.md'),'utf8')).toBe('keep memory');
  expect(await migrateAppAgentContainer(entry,agent,{injectAgentService},run)).toBe(false);
  expect(injectAgentService).toHaveBeenCalledTimes(1);
});
test.each(['privileged','foreign-mount','foreign-project'])('refuses %s before rewriting or recreating', async kind => {
  if(kind==='privileged')inspection.HostConfig.Privileged=true;
  if(kind==='foreign-mount')inspection.Mounts.push({Type:'bind',Source:root,Destination:'/host',RW:true});
  if(kind==='foreign-project')inspection.Config.Labels['com.docker.compose.project']='other';
  const injectAgentService=jest.fn(),run=jest.fn(async()=>JSON.stringify([inspection]));
  await expect(migrateAppAgentContainer(entry,agent,{injectAgentService},run)).rejects.toThrow();
  expect(injectAgentService).not.toHaveBeenCalled();expect(run).toHaveBeenCalledTimes(1);
});
test('disabled orchestration leaves the existing container alone', async () => {
  agent.orchestration!.enabled=false;
  const run=jest.fn(),injectAgentService=jest.fn();
  expect(await migrateAppAgentContainer(entry,agent,{injectAgentService},run)).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
test('failed recreate preserves the compose backup and does not restore unsafe mounts automatically', async () => {
  const injectAgentService=jest.fn(()=>writeFileSync(join(root,'docker-compose.yml'),'new compose'));
  const run=jest.fn(async(args:string[])=>{if(args[0]==='compose')throw Error('recreate failed');return JSON.stringify([inspection]);});
  await expect(migrateAppAgentContainer(entry,agent,{injectAgentService},run)).rejects.toThrow('recreate failed');
  expect(readFileSync(join(root,'docker-compose.yml'),'utf8')).toBe('original compose');
  expect(run.mock.calls.filter(([args])=>args[0]==='compose')).toHaveLength(1);
});


test('stopped legacy container passes configuration preflight but must be running after recreation', async () => {
 inspection.State.Running=false;
 const injectAgentService=jest.fn();
 const run=jest.fn(async(args:string[])=>{
  if(args[0]==='compose'){inspection.Mounts.pop();inspection.State.Running=true;return '';}
  return JSON.stringify([inspection]);
 });
 expect(await migrateAppAgentContainer(entry,agent,{injectAgentService},run)).toBe(true);
 expect(injectAgentService).toHaveBeenCalledTimes(1);
});
test('offline preflight still rejects disabled security protection', async () => {
 inspection.State.Running=false;inspection.HostConfig.SecurityOpt=['no-new-privileges=false'];
 const injectAgentService=jest.fn();
 await expect(migrateAppAgentContainer(entry,agent,{injectAgentService},async()=>JSON.stringify([inspection]))).rejects.toThrow('CONTAINER_ISOLATION_REQUIRED');
 expect(injectAgentService).not.toHaveBeenCalled();
});

describe('explicit runtime refresh', () => {
  const { refreshAppAgentRuntime } = require('../../../src/apps/agent-container-migration');
  beforeEach(() => {
    inspection.Id = 'owned-container';
    inspection.State = { Running: false, Status: 'exited' };
  });
  test('refreshes only a stopped owned agent, preserving workspace and application services', async () => {
    const injectAgentService = jest.fn(() => writeFileSync(join(root, 'docker-compose.yml'), 'refreshed compose'));
    const run = jest.fn(async (args: string[]) => {
      if (args[0] === 'compose') { inspection.Mounts.pop(); inspection.State = { Running: true, Status: 'running' }; return ''; }
      return JSON.stringify([inspection]);
    });
    await refreshAppAgentRuntime(entry, agent, { injectAgentService }, run);
    expect(run.mock.calls.filter(([args]) => args[0] === 'compose').map(([args]) => args)).toEqual([
      ['compose', '-p', 'app', '-f', join(root, 'docker-compose.yml'), 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'agent'],
    ]);
    expect(readFileSync(join(root, 'workspace', 'MEMORY.md'), 'utf8')).toBe('keep memory');
    expect(injectAgentService).toHaveBeenCalledTimes(1);
  });
  test('refreshes a stopped legacy agent from raw config without orchestration defaults', async () => {
    delete agent.orchestration;
    const injectAgentService = jest.fn();
    const run = jest.fn(async (args: string[]) => {
      if (args[0] === 'compose') { inspection.Mounts.pop(); inspection.State = { Running: true, Status: 'running' }; return ''; }
      return JSON.stringify([inspection]);
    });
    await refreshAppAgentRuntime(entry, agent, { injectAgentService }, run);
    expect(injectAgentService).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.filter(([args]) => args[0] === 'compose')).toHaveLength(1);
  });
  test.each(['running', 'restarting', 'unknown-state', 'foreign-project', 'foreign-mount', 'privileged'])('rejects %s before any generated-file change', async kind => {
    if (kind === 'running') inspection.State = { Running: true, Status: 'running' };
    if (kind === 'restarting') inspection.State.Restarting = true;
    if (kind === 'unknown-state') delete inspection.State.Status;
    if (kind === 'foreign-project') inspection.Config.Labels['com.docker.compose.project'] = 'foreign';
    if (kind === 'foreign-mount') inspection.Mounts.push({ Type: 'bind', Source: root, Destination: '/host', RW: true });
    if (kind === 'privileged') inspection.HostConfig.Privileged = true;
    const injectAgentService = jest.fn();
    const run = jest.fn(async () => JSON.stringify([inspection]));
    await expect(refreshAppAgentRuntime(entry, agent, { injectAgentService }, run)).rejects.toThrow();
    expect(injectAgentService).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toBe('original compose');
  });
  test('refuses an agent started after preflight and restores generated files', async () => {
    const injectAgentService = jest.fn(() => {
      writeFileSync(join(root, 'docker-compose.yml'), 'refreshed compose');
      writeFileSync(join(root, 'Dockerfile.agent'), 'new dockerfile');
      inspection.State = { Running: true, Status: 'running' };
    });
    const run = jest.fn(async () => JSON.stringify([inspection]));
    await expect(refreshAppAgentRuntime(entry, agent, { injectAgentService }, run)).rejects.toThrow('CONTAINER_REFRESH_STOP_REQUIRED');
    expect(run).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toBe('original compose');
    expect(require('fs').existsSync(join(root, 'Dockerfile.agent'))).toBe(false);
  });
  test('failed post-refresh admission reports failure without starting other services or rollback recreation', async () => {
    const injectAgentService = jest.fn(() => writeFileSync(join(root, 'docker-compose.yml'), 'refreshed compose'));
    const run = jest.fn(async (args: string[]) => {
      if (args[0] === 'compose') { inspection.HostConfig.Privileged = true; return ''; }
      return JSON.stringify([inspection]);
    });
    await expect(refreshAppAgentRuntime(entry, agent, { injectAgentService }, run)).rejects.toThrow('CONTAINER_ISOLATION_REQUIRED');
    expect(run.mock.calls.filter(([args]) => args[0] === 'compose')).toHaveLength(1);
    expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toBe('original compose');
  });
});

describe('stopped refresh of stale generated native runtime mounts', () => {
  const { refreshAppAgentRuntime } = require('../../../src/apps/agent-container-migration');
  const label = 'ai.claude-gateway.codex-runtime';
  let source: string, target: string;
  beforeEach(() => {
    inspection.Id = 'owned-container'; inspection.State = { Running: false, Status: 'exited' };
    source = join(root, 'removed-codex'); target = '/opt/gateway-codex/bin/codex';
    inspection.Config.Labels[label] = 'a'.repeat(64);
    inspection.Mounts.push({ Type: 'bind', Source: source, Destination: target, RW: false });
    writeFileSync(join(root, 'docker-compose.yml'), require('js-yaml').dump({ services: { agent: {
      labels: { [label]: 'a'.repeat(64) }, volumes: [{ type: 'bind', source, target, read_only: true }],
    } } }));
  });
  test('recovers a deleted old runtime file only with exact saved generated mount evidence', async () => {
    const injectAgentService = jest.fn();
    const run = jest.fn(async (args: string[]) => {
      if (args[0] === 'compose') { inspection.Mounts.splice(1); inspection.State = { Running: true }; return ''; }
      return JSON.stringify([inspection]);
    });
    await refreshAppAgentRuntime(entry, agent, { injectAgentService }, run);
    expect(injectAgentService).toHaveBeenCalledTimes(1);
  });
  test.each(['fingerprint', 'source', 'destination', 'writable', 'short-volume'])('does not exempt unverified old mount: %s', async kind => {
    if (kind === 'fingerprint') inspection.Config.Labels[label] = 'b'.repeat(64);
    if (kind === 'source') inspection.Mounts[2].Source = join(root, 'different-source');
    if (kind === 'destination') inspection.Mounts[2].Destination = '/host';
    if (kind === 'writable') inspection.Mounts[2].RW = true;
    if (kind === 'short-volume') writeFileSync(join(root, 'docker-compose.yml'), require('js-yaml').dump({ services: { agent: {
      labels: { [label]: 'a'.repeat(64) }, volumes: [`${source}:${target}:ro`],
    } } }));
    const injectAgentService = jest.fn();
    await expect(refreshAppAgentRuntime(entry, agent, { injectAgentService }, async () => JSON.stringify([inspection]))).rejects.toThrow();
    expect(injectAgentService).not.toHaveBeenCalled();
  });
});
