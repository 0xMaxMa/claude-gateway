import {ComputerConnectors} from '../../../src/jev/computer-connector';
import {resolveBrowserConnection} from '../../../src/jev/browser-connector';
import {containerTaskTools} from '../../../src/orchestration/container-tool-schemas';
jest.mock('../../../src/connectors/resolve',()=>({resolveEnabledConnectors:()=>({computer:{}})}));
jest.mock('../../../src/jev/browser-connector',()=>({resolveBrowserConnection:jest.fn(()=>({endpoint:'https://computer.example/mcp',headers:{Authorization:'Bearer secret'}}))}));
const config=()=>({gateway:{customConnectors:{computer:{resourcesPath:'/v1/computer-grants'}}}} as any);
const grant={id:'00000000-0000-4000-8000-000000000001',deviceId:'00000000-0000-4000-8000-000000000002',online:true,ready:true,policy:{observe:true,control:true,allowedApps:['com.apple.Notes']}};
const context={principalId:'p',conversationId:'c',execute:false} as any;
const original=global.fetch;
beforeEach(()=>{jest.mocked(resolveBrowserConnection).mockReset().mockReturnValue({endpoint:'https://computer.example/mcp',headers:{Authorization:'Bearer secret'}});});
afterEach(()=>{global.fetch=original;});
test('discovery supports app agents but targets never cross principals or conversations',async()=>{
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[grant]})));
 const connectors=new ComputerConnectors(config(),{id:'app',type:'app-agent'} as any);
 const [target]=await connectors.discover(context,()=>true);expect(target).toBeDefined();expect(JSON.stringify(target)).not.toContain('secret');
 expect(()=>connectors.get(target.id,'other','c')).toThrow();expect(()=>connectors.get(target.id,'p','other')).toThrow();
 expect(connectors.get(target.id,'p','c')).toEqual(target);
});
test('offline and expired devices are excluded; paired devices remain discoverable before consent',async()=>{
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[{...grant,online:false},{...grant,expiresAt:1},{...grant,ready:false},{...grant,policy:{...grant.policy,control:false}}]})));
 const rows=await new ComputerConnectors(config(),{id:'a'} as any).discover({...context,execute:true},()=>true);expect(rows).toHaveLength(2);expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('revocation during discovery and credential rotation prevent target publication',async()=>{
 let allowed=true;global.fetch=jest.fn(async()=>{allowed=false;return new Response(JSON.stringify({grants:[grant]}));});
 await expect(new ComputerConnectors(config(),{id:'a'} as any).discover(context,()=>allowed)).rejects.toThrow('ACCESS_DENIED');
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[grant]})));
 jest.mocked(resolveBrowserConnection).mockReturnValueOnce({endpoint:'https://computer.example/mcp',headers:{Authorization:'old'}}).mockReturnValueOnce({endpoint:'https://computer.example/mcp',headers:{Authorization:'new'}});
 await expect(new ComputerConnectors(config(),{id:'a'} as any).discover(context,()=>true)).rejects.toThrow('COMPUTER_CONNECTOR_CHANGED');
});
test('computer-only container inventory grants neither safemode nor browser verification',()=>{
 const tools=containerTaskTools('agent',true,false,true);
 const discover=tools.find(t=>t.name==='capabilities_list')!;expect((discover.inputSchema.properties as any).scope.enum).toEqual(['capabilities','computer']);
 const spawn=tools.find(t=>t.name==='task_spawn')!;expect((spawn.inputSchema.properties as any).gateway_target.properties.adapter.enum).toEqual(['computer']);
 expect((tools.find(t=>t.name==='task_status')!.inputSchema.properties as any).browser_evidence).toBeUndefined();
});

test('owner stop evidence is scoped to the exact paired device and grant',async()=>{
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[grant]})));
 const connectors=new ComputerConnectors(config(),{id:'a'} as any);
 const [binding]=await connectors.discover(context,()=>true);
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[{...grant,ready:false,stoppedAt:1234}]})));
 expect(await connectors.stoppedAt(binding.id,'p','c')).toBe(1234);
 await expect(connectors.stoppedAt(binding.id,'other','c')).rejects.toThrow();
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[{...grant,deviceId:'other',stoppedAt:1234}]})));
 expect(await connectors.stoppedAt(binding.id,'p','c')).toBeUndefined();
});

test('connection status distinguishes offline, missing approval and reconnection',async()=>{
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[grant]})));
 const connectors=new ComputerConnectors(config(),{id:'a'} as any);
 const [binding]=await connectors.discover(context,()=>true);
 for(const [online,ready,status] of [[false,false,'disconnected'],[true,false,'waiting_access'],[true,true,'connected']] as const){
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({grants:[{...grant,online,ready}]})));
  expect((await connectors.accessState(binding.id,'p','c')).status).toBe(status);
 }
 await expect(connectors.accessState(binding.id,'other','c')).rejects.toThrow();
 global.fetch=jest.fn(async()=>new Response('unavailable',{status:503}));
 await expect(connectors.accessState(binding.id,'p','c')).rejects.toThrow('COMPUTER_DISCOVERY_UNAVAILABLE');
});
