import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentConfig } from '../../../src/types';
let mockInspect: any;
jest.mock('child_process',()=>{
 const {promisify}=require('util');const execFile=jest.fn();
 Object.defineProperty(execFile,promisify.custom,{value:async()=>({stdout:JSON.stringify([mockInspect])})});
 return {execFile,spawn:jest.fn()};
});
import { assertContainerBinding, validateContainer } from '../../../src/orchestration/container';

test('a missing container or changed app type never selects a host process',()=>{
 expect(()=>assertContainerBinding({type:'app-agent'})).toThrow('Host fallback');
 expect(()=>assertContainerBinding({}, {containerExecution:true})).toThrow('Host fallback');
 expect(()=>assertContainerBinding({type:'app-agent',container:'app-agent'}, {containerExecution:true})).not.toThrow();
});
test('Docker preflight rejects namespaces, privilege and alternate host mounts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'container-guard-')),workspace=join(root,'workspace');mkdirSync(workspace);mkdirSync(join(root,'media'));
 const agent={id:'a',type:'app-agent',container:'app-agent',workspace} as AgentConfig;
 const healthy=()=>({State:{Running:true},HostConfig:{Privileged:false,NetworkMode:'app_default',PidMode:'',IpcMode:'private',CapDrop:['ALL'],SecurityOpt:['no-new-privileges']},Mounts:[{Source:workspace,Destination:'/workspace',RW:true}]});
 try {
  mockInspect=healthy();await expect(validateContainer(agent)).resolves.toBeUndefined();
  for(const patch of [{Privileged:true},{NetworkMode:'host'},{NetworkMode:'container:other'},{PidMode:'host'},{IpcMode:'host'},{CapAdd:['SYS_ADMIN']},{CapDrop:[]},{SecurityOpt:[]}]){mockInspect=healthy();Object.assign(mockInspect.HostConfig,patch);await expect(validateContainer(agent)).rejects.toMatchObject({code:'CONTAINER_ISOLATION_REQUIRED'});}
  for(const mount of [{Source:'/',Destination:'/host',RW:true},{Source:'/',Destination:'/usr/bin/node',RW:false},{Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock',RW:true}]){mockInspect=healthy();mockInspect.Mounts.push(mount);await expect(validateContainer(agent)).rejects.toMatchObject({code:'CONTAINER_HOST_MOUNT_DENIED'});}
 }finally{rmSync(root,{recursive:true,force:true});}
});
