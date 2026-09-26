import {inspectBrowser,resolveBrowserConnection,validateBrowserVerification} from '../../../src/jev/browser-connector';
import {customSecretKey} from '../../../src/connectors/custom';
const mockCall=jest.fn(),mockClose=jest.fn(async()=>{}),mockTokens:Record<string,string>={};
jest.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:jest.fn().mockImplementation(()=>({connect:async()=>{},callTool:mockCall,close:mockClose}))}));
jest.mock('../../../src/connectors/token-env',()=>({readTokenEnv:()=>mockTokens}));
const binding:any={id:'b',name:'Browser',agentId:'a',principalId:'u',conversationId:'c',connectorId:'paired',scope:{device_id:'d',grant_id:'g',tab_id:'t'}};
const connection={endpoint:'https://browser.example/mcp',headers:{Authorization:'Bearer fixture-private'}};
const lease='11111111-1111-4111-8111-111111111111';
const observation={protocol_version:1,generation:'current',url:'https://fixture.example',text:'Name',elements:[{ref:'x',label:'Name'}]};
const reply=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
beforeEach(()=>{mockCall.mockReset();mockClose.mockClear();for(const k of Object.keys(mockTokens))delete mockTokens[k];});
test('uses native connector enablement and existing secret store without persisting headers',()=>{
 const config:any={gateway:{customConnectors:{paired:{config:{type:'http',url:'https://browser.example/mcp',headers:{Authorization:'Bearer {token}'}},secretNames:['token']}}}};
 mockTokens[customSecretKey('paired','token')]='fixture-private';
 expect(resolveBrowserConnection(config,{} as any,'paired')).toEqual(connection);
 expect(()=>resolveBrowserConnection(config,{connectors:{paired:{enabled:false}}} as any,'paired')).toThrow();
 config.gateway.connectorsDefaultEnabled=false;expect(()=>resolveBrowserConnection(config,{} as any,'paired')).toThrow();
 expect(resolveBrowserConnection(config,{connectors:{paired:{enabled:true}}} as any,'paired')).toEqual(connection);
 delete mockTokens[customSecretKey('paired','token')];expect(()=>resolveBrowserConnection(config,{connectors:{paired:{enabled:true}}} as any,'paired')).toThrow();
 expect(()=>resolveBrowserConnection(config,{} as any,'constructor')).toThrow();
});
test('leased fresh inspection uses only retained operation ID and releases the lease',async()=>{
 mockCall.mockImplementation(async({name})=>reply(name==='browser_task_acquire'?{state:'completed',result:{protocol_version:1,lease_token:lease}}:name==='page_observe'?observation:{state:'completed'}));
 const value=await inspectBrowser(binding,{status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:2,lastAction:{operationId:'retained',operation:'TYPE_TEXT',outcome:'confirmed'}},new AbortController().signal,()=>true,connection);
 expect(value.observation).toEqual(observation);
 expect(mockCall.mock.calls.map(c=>c[0].name)).toEqual(['browser_task_acquire','page_observe','operation_status','browser_task_release']);
 expect(mockCall.mock.calls[1][0].arguments).toEqual({...binding.scope,lease_token:lease,detail:'full'});
 expect(mockCall.mock.calls[2][0].arguments).toEqual({operation_id:'retained'});
 expect(mockClose).toHaveBeenCalled();
});
test.each(['pending','denied'])('a non-error MCP access %s envelope is never scope proof',async state=>{
 mockCall.mockImplementation(async({name})=>reply(name==='browser_task_acquire'?{state:'completed',result:{protocol_version:1,lease_token:lease}}:{access:{state},action_executed:false}));
 await expect(inspectBrowser(binding,undefined,new AbortController().signal,()=>true,connection)).rejects.toThrow('BROWSER_EVIDENCE_INVALID');
 expect(mockCall.mock.calls.map(c=>c[0].name)).toEqual(['browser_task_acquire','page_observe','browser_task_release']);
});
test('revocation during observation rejects evidence while still releasing owned lease',async()=>{
 let allowed=true;mockCall.mockImplementation(async({name})=>{if(name==='page_observe')allowed=false;return reply(name==='browser_task_acquire'?{state:'completed',result:{protocol_version:1,lease_token:lease}}:observation);});
 await expect(inspectBrowser(binding,undefined,new AbortController().signal,()=>allowed,connection)).rejects.toThrow('ACCESS_DENIED');
 expect(mockCall.mock.calls.at(-1)?.[0].name).toBe('browser_task_release');
});

test('malformed installed verifier results retain INVALID_CONTRACT rather than becoming false',()=>{
 for(const value of ['false',{verified:false},0,null,undefined]){
  try{validateBrowserVerification(value);throw Error('accepted');}catch(e){expect(e).toMatchObject({code:'INVALID_CONTRACT'});}
 }
 expect(validateBrowserVerification(false)).toBe(false);expect(validateBrowserVerification(true)).toBe(true);
});
test('screenshot stays under the same approved lease and is an image, not page instructions',async()=>{
 const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgo='};
 mockCall.mockImplementation(async({name})=>name==='page_screenshot'?{content:[image]}:reply(name==='browser_task_acquire'?{state:'completed',result:{protocol_version:1,lease_token:lease}}:observation));
 const value=await inspectBrowser(binding,undefined,new AbortController().signal,()=>true,connection,true);
 expect(value.screenshot).toEqual(image);
 expect(mockCall.mock.calls.find(c=>c[0].name==='page_screenshot')?.[0].arguments).toEqual({...binding.scope,lease_token:lease});
 expect(mockCall.mock.calls.at(-1)?.[0].name).toBe('browser_task_release');
});
test('revoking during screenshot prevents image delivery',async()=>{
 let allowed=true;
 mockCall.mockImplementation(async({name})=>{if(name==='page_screenshot'){allowed=false;return {content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgo='}]};}return reply(name==='browser_task_acquire'?{state:'completed',result:{protocol_version:1,lease_token:lease}}:observation);});
 await expect(inspectBrowser(binding,undefined,new AbortController().signal,()=>allowed,connection,true)).rejects.toThrow('ACCESS_DENIED');
 expect(mockCall.mock.calls.at(-1)?.[0].name).toBe('browser_task_release');
});
