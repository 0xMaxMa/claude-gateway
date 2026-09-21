import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { SafemodeTaskAdapter } from '../../../src/orchestration/gateway-tasks/safemode';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';
import { validateJevConfig } from '../../../src/jev/validation';
import { TaskSnapshot } from '../../../src/orchestration/types';
jest.mock('child_process',()=>({...jest.requireActual('child_process'),spawn:jest.fn()}));
test('gateway-created safemode request child receives no Jev key and keeps native CLI auth',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jev-safemode-env-')),id='11111111-1111-4111-8111-111111111111';
 const original={...process.env};
 validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'PRIVATE_SAFEMODE_JEV_TOKEN'});
 Object.assign(process.env,{TYPESAFE_API_KEY:'a',JEV_API_KEY:'b',PRIVATE_SAFEMODE_JEV_TOKEN:'c',ANTHROPIC_API_KEY:'native-claude',OPENAI_API_KEY:'native-codex'});
 const child=Object.assign(new EventEmitter(),{unref:jest.fn()});
 (spawn as jest.Mock).mockImplementation(()=>{setImmediate(()=>child.emit('spawn'));return child;});
 try{
  mkdirSync(join(root,id));atomicJson(join(root,id,'session.json'),{id,name:'fixture',cli:'codex',nativeSessionId:id,agentId:'a',createdAt:new Date().toISOString()});
  new SafemodeStore(root).assign(id,'a');
  const adapter=new SafemodeTaskAdapter('a',()=>true,()=>new SafemodeStore(root));
  await adapter.submit({agentId:'a',gatewayTarget:{adapter:'safemode',sessionId:id}} as TaskSnapshot,'request-one','Inspect authorized work');
  const env=(spawn as jest.Mock).mock.calls[0][2].env;
  expect(env.ANTHROPIC_API_KEY).toBe('native-claude');expect(env.OPENAI_API_KEY).toBe('native-codex');
  for(const key of ['TYPESAFE_API_KEY','JEV_API_KEY','PRIVATE_SAFEMODE_JEV_TOKEN'])expect(env).not.toHaveProperty(key);
 }finally{process.env=original;rmSync(root,{recursive:true,force:true});jest.clearAllMocks();}
});
