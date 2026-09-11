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
