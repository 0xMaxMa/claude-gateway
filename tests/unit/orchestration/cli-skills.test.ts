import {tmpdir} from 'os';
import {mkdtempSync,writeFileSync,rmSync} from 'fs';
import {join} from 'path';
import {probeCliSkills,parseCliSkills} from '../../../src/orchestration/cli-skills';
import {resolveSkill,resolveNamedSkill,skillCatalog} from '../../../src/orchestration/skills';
import {loadSkills} from '../../../src/skills/loader';
import {mkdirSync} from 'fs';

const cli=[{name:'code-review',description:'Review a local diff',aliases:['review']}];
test('runtime native names and aliases resolve without a fabricated file or skill body',()=>{
 const registry={skills:new Map(),cliSkills:cli};
 expect(resolveSkill('/code-review low','telegram',registry)).toEqual({name:'code-review',args:'low',invocation:'cli',content:'',filePath:''});
 expect(resolveNamedSkill('review','local',registry)).toMatchObject({name:'code-review',invocation:'cli'});
 expect(resolveNamedSkill('invented','',registry)).toBeUndefined();
 expect(resolveNamedSkill('../code-review','',registry)).toBeUndefined();
 expect(skillCatalog(registry)).toContain('Claude Code runtime skills');
 expect(skillCatalog({...registry,cliDiscoveryError:'unavailable'})).toContain('Do not infer');
});
test('shared skills remain discoverable with resources and keep gateway precedence',()=>{
 const root=mkdtempSync(join(tmpdir(),'shared-skill-catalog-'));
 try{
  const shared=join(root,'shared');mkdirSync(join(shared,'code-review'),{recursive:true});
  const file=join(shared,'code-review','SKILL.md');writeFileSync(file,'---\nname: code-review\ndescription: Shared review\n---\nUse helper.txt');
  writeFileSync(join(shared,'code-review','helper.txt'),'resource');
  const registry=loadSkills({workspaceDir:root,sharedSkillsDir:shared});registry.cliSkills=cli;
  expect(resolveSkill('/code-review 123','api',registry)).toMatchObject({name:'code-review',filePath:file,content:expect.stringContaining('helper.txt')});
  expect(resolveSkill('/code-review 123','api',registry)?.invocation).toBeUndefined();
  expect(skillCatalog(registry)).toContain('"source":"shared"');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('initialize handshake reads only metadata and does not send a user prompt',async()=>{
 const script=`process.stdin.once('data', data=>{
  const request=JSON.parse(data.toString());
  if(request.type!=='control_request'||request.request.subtype!=='initialize')process.exit(2);
  process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{commands:[{name:'code-review',description:'Review',aliases:['review']}],account:{secret:'not-a-catalog-field'}}}})+'\\n');
 });setInterval(()=>{},1000);`;
 const result=await probeCliSkills(process.execPath,['-e',script],tmpdir());
 expect(result).toEqual([{name:'code-review',description:'Review',argumentHint:'',aliases:['review']}]);
 expect(JSON.stringify(result)).not.toContain('secret');
});
test('failed CLI initialization does not advertise invented native skills',async()=>{
 await expect(probeCliSkills(process.execPath,['-e','process.exit(1)'],tmpdir())).rejects.toThrow('CLI_SKILL_DISCOVERY_UNAVAILABLE');
 expect(parseCliSkills([{name:'../escape',description:'bad'},{name:'valid',description:'ok',aliases:['/bad','good']},null])).toEqual([{name:'valid',description:'ok',argumentHint:'',aliases:['good']}]);
 expect(()=>parseCliSkills(null)).toThrow('CLI_SKILL_DISCOVERY_INVALID');
});

test('app discovery validates the container and never falls back to the host CLI',async()=>{
 const container=await import('../../../src/orchestration/container');
 const child=require('child_process') as typeof import('child_process');
 const discovery=await import('../../../src/orchestration/cli-skills');
 const agent={id:'app',type:'app-agent',container:'fixture-native-skills',workspace:tmpdir(),claudeBin:'claude'} as any;
 const validate=jest.spyOn(container,'validateContainer').mockRejectedValue(new Error('CONTAINER_ISOLATION_REQUIRED'));
 const spawn=jest.spyOn(child,'spawn');
 try{
  await expect(discovery.discoverCliSkills(agent)).rejects.toThrow('CONTAINER_ISOLATION_REQUIRED');
  expect(spawn).not.toHaveBeenCalled();
  validate.mockResolvedValue(undefined);
  spawn.mockImplementation(()=>{throw new Error('captured docker invocation');});
  await expect(discovery.discoverCliSkills({...agent,container:'fixture-native-skills-valid'})).rejects.toThrow('captured docker invocation');
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0][0]).toBe('docker');
  const args=spawn.mock.calls[0][1] as string[];
  expect(args).toEqual(expect.arrayContaining(['exec','/workspace','fixture-native-skills-valid','claude','--strict-mcp-config']));
  expect(args[args.indexOf('--setting-sources')+1]).toBe('');
 }finally{jest.restoreAllMocks();}
});
