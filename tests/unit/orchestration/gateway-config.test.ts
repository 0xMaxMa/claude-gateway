import { withConfigWriteLock } from '../../../src/config/config-write-lock';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {applyGatewayOrchestration,effectiveOrchestration,ORCHESTRATION_CHANNELS,validateGatewayOrchestration} from '../../../src/orchestration/gateway-config';
import {resolveOrchestrationConfig} from '../../../src/orchestration/config';
import {AgentConfig,GatewayConfig} from '../../../src/types';
import {loadConfig} from '../../../src/config/loader';
import {ConfigWatcher} from '../../../src/config/watcher';
const agent=():AgentConfig=>({id:'a',workspace:'/tmp/a/workspace',env:'',description:'',claude:{model:'fixture',extraFlags:[]}});
test('gateway boolean alone controls every Agent/channel and cannot be overridden by old Agent flags',()=>{
 for(const enabled of [true,false])for(const oldAgentFlag of [undefined,true,false]){
  const a=agent();a.orchestration={...(oldAgentFlag===undefined?{}:{enabled:oldAgentFlag}),channels:['api']};
  applyGatewayOrchestration(a,{gateway:{orchestration:enabled}} as GatewayConfig);
  expect(a.orchestration!.enabled).toBe(enabled);expect(a.orchestration!.channels).toEqual(ORCHESTRATION_CHANNELS);
  expect(JSON.stringify(a.orchestration)).toBe('{}');
 }
 expect(effectiveOrchestration({enabled:true},undefined).enabled).toBe(false);
});
test('global voice defaults merge deeply; Agent overrides survive gateway updates and disabling retains valid settings',()=>{
 const original={voice:{tts:{voiceId:'agent-voice'}}};
 let config=effectiveOrchestration(original,{enabled:true,voice:{enabled:true,notes:{enabled:true,replyWithVoice:true},stt:{provider:'elevenlabs',model:'scribe_v2_realtime'},tts:{provider:'elevenlabs',model:'global-model',voiceId:'global-voice'}}});
 expect(resolveOrchestrationConfig(config).voice.tts).toMatchObject({provider:'elevenlabs',model:'global-model',voiceId:'agent-voice'});
 config=effectiveOrchestration(config,{enabled:true,voice:{tts:{provider:'cartesia',model:'new-model',voiceId:'new-default'}}});
 expect(JSON.parse(JSON.stringify(config))).toEqual(original);
 expect(config.voice!.tts).toEqual({provider:'cartesia',model:'new-model',voiceId:'agent-voice'});
 expect(effectiveOrchestration(original,false).enabled).toBe(false);
 const disabled=effectiveOrchestration({}, {enabled:false,voice:{enabled:true,notes:{enabled:true,replyWithVoice:true},tts:{voiceId:'saved'}}});expect(disabled.enabled).toBe(false);
});
test('loader validates global settings and watcher identifies one hot-reloadable gateway switch',()=>{
 const root=mkdtempSync(join(tmpdir(),'global-orchestration-')),path=join(root,'config.json');
 try{
  const raw={gateway:{headless:true,logDir:root,timezone:'UTC',orchestration:true as any},agents:[agent(),{...agent(),id:'b'}]};
  writeFileSync(path,JSON.stringify(raw));const before=loadConfig(path);expect(before.gateway.orchestration).toBe(true);
  for(const a of before.agents)expect(applyGatewayOrchestration(a,before).orchestration!.enabled).toBe(true);
  const watcher=new ConfigWatcher(path,before,{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()} as any);
  raw.gateway.orchestration=false;writeFileSync(path,JSON.stringify(raw));
  const after=loadConfig(path),diff=(watcher as any).diffConfig(before,after);
  expect(diff.fieldChanges).toEqual(expect.arrayContaining([expect.objectContaining({field:'gateway.orchestration',hotReloadable:true,newValue:false})]));
  raw.gateway.orchestration='yes';writeFileSync(path,JSON.stringify(raw));expect(()=>loadConfig(path)).toThrow();
  expect(()=>validateGatewayOrchestration({enabled:true,channels:['line']})).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('orchestration persists headless true without changing unrelated raw config or legacy mode',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-headless-')),file=join(root,'config.json');
 try {
  const raw={gateway:{headless:false,orchestration:true,logDir:root},agents:[]};
  writeFileSync(file,JSON.stringify(raw));
  expect(loadConfig(file).gateway.headless).toBe(true);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({...raw,gateway:{...raw.gateway,headless:true}});
  raw.gateway.orchestration=false;writeFileSync(file,JSON.stringify(raw));
  expect(loadConfig(file).gateway.headless).toBe(false);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(raw);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('headless persistence queues behind config writers and preserves their updates', async()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-headless-lock-')),file=join(root,'config.json');
 try {
  const raw={gateway:{headless:false,orchestration:true,logDir:root},agents:[]};
  writeFileSync(file,JSON.stringify(raw));
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});
  const pending=withConfigWriteLock(file,async()=>{await hold;writeFileSync(file,JSON.stringify({...raw,added:'retained'}));});
  expect(loadConfig(file).gateway.headless).toBe(true);
  release();await pending;await withConfigWriteLock(file,()=>{});
  expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({added:'retained',gateway:{headless:true}});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('voice replies default allowed and only Agent policy can disable them',()=>{
 for(const global of [true,{enabled:true,voice:{notes:{enabled:false,replyWithVoice:false}}}]){
  const effective=effectiveOrchestration({},global);
  expect(effective.voice?.notes?.replyWithVoice ?? true).toBe(true);
  expect(resolveOrchestrationConfig(effective).voice.notes.replyWithVoice).toBe(true);
  const denied=effectiveOrchestration({voice:{notes:{replyWithVoice:false}}},global);
  expect(denied.voice?.notes?.replyWithVoice).toBe(false);
  expect(effectiveOrchestration(denied,global).voice?.notes?.replyWithVoice).toBe(false);
  expect(JSON.parse(JSON.stringify(denied))).toEqual({voice:{notes:{replyWithVoice:false}}});
 }
 expect(resolveOrchestrationConfig({voice:{notes:{enabled:false}}}).voice.notes.replyWithVoice).toBe(true);
});

test('ordinary Agents default to general host work without rewriting explicit workspace policy',()=>{
 const implicit=effectiveOrchestration({},true);
 expect(resolveOrchestrationConfig(implicit).tasks).toMatchObject({workspaceMode:'host',projectRoot:''});
 expect(JSON.parse(JSON.stringify(implicit))).toEqual({});
 for(const mode of ['isolated-worktree','shared-lock','host','container'] as const){
  const explicit={tasks:{workspaceMode:mode}};
  const effective=effectiveOrchestration(explicit,true);
  expect(resolveOrchestrationConfig(effective).tasks.workspaceMode).toBe(mode);
  expect(JSON.parse(JSON.stringify(effective))).toEqual(explicit);
 }
});
