import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectBrowser,executeBrowserModule} from '../../../src/jev/browser-connector';
const mockCall=jest.fn(),mockClose=jest.fn(async()=>{});
const mockListTools=jest.fn(async()=>({tools:[{name:'browser_request_access'}]}));
jest.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:jest.fn().mockImplementation(()=>({connect:async()=>{},callTool:mockCall,listTools:mockListTools,close:mockClose}))}));
// Jest's VM has no native dynamic import; load the fixture runner with require.
jest.mock('../../../src/jev/browser-module-import',()=>({importBrowserModule:async(url:string)=>{const {fileURLToPath}=require('node:url');return require(fileURLToPath(url));}}));
const binding:any={id:'b',name:'Browser',agentId:'a',principalId:'u',conversationId:'c',connectorId:'paired',scope:{device_id:'d',grant_id:'g',tab_id:'t'}};
const connection={endpoint:'https://browser.example/mcp',headers:{Authorization:'Bearer fixture-private'}};
const lease='11111111-1111-4111-8111-111111111111';
const observation={protocol_version:1,generation:'current',url:'https://fixture.example',text:'Name',elements:[{ref:'x',label:'Name'}]};
const reply=(value:unknown,isError=false)=>({content:[{type:'text',text:JSON.stringify(value)}],...(isError?{isError:true}:{})});
let dir:string;
beforeEach(()=>{mockCall.mockReset();mockClose.mockClear();dir=mkdtempSync(join(tmpdir(),'browser-direct-connector-'));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));

test('fresh inspection retries a read during navigation commit instead of failing',async()=>{
 let pending=2;
 mockCall.mockImplementation(async({name})=>name==='browser_task_acquire'?reply({state:'completed',result:{protocol_version:1,lease_token:lease}}):
  name==='page_observe'&&pending-->0?reply({error:'STALE_OBSERVATION',cause:'NAVIGATION_PENDING',action_executed:false},true):reply(name==='page_observe'?observation:{state:'completed'}));
 const fresh=await inspectBrowser(binding,undefined,AbortSignal.timeout(5000),()=>true,connection);
 expect(fresh.observation).toMatchObject({generation:'current'});
 expect(mockCall.mock.calls.filter(c=>c[0].name==='page_observe')).toHaveLength(3);
 expect(mockCall.mock.calls.at(-1)?.[0].name).toBe('browser_task_release');
});

/** A minimal installed runner that dispatches the given tools through the host transport. */
let runners=0;
function runner(tools:string[],features?:string[]){
 const file=join(dir,`runner-${++runners}.cjs`);
 writeFileSync(file,`exports.BROWSER_USE_CONTRACT_VERSION=1;${features?`exports.BROWSER_USE_FEATURES=${JSON.stringify(features)};`:''}
exports.mcpBrowserTransport=invoke=>async(name,args,signal)=>{const r=await invoke(name,args,signal);return JSON.parse(r.content[0].text);};
exports.runBrowserUse=async(input,deps)=>{globalThis.__browserInput=input;for(const [i,name] of ${JSON.stringify(tools)}.entries())await deps.call(name,{...input.scope,operation_id:'00000000-0000-4000-8000-00000000000'+i},new AbortController().signal);return {status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:${tools.length},evaluations:0};};`);
 return file;
}
const context=(patch:Record<string,unknown>={})=>({goal:'enter',signal:new AbortController().signal,authorized:()=>true,evaluate:jest.fn(),progress:jest.fn(),beforeMutation:jest.fn(),...patch}) as any;

test('page_keypress and tab_history are allowed mutations behind the write-ahead fence',async()=>{
 mockCall.mockImplementation(async()=>reply({state:'completed',result:{}}));
 const c=context();
 const result=await executeBrowserModule(runner(['page_keypress','tab_history']),binding,c,connection);
 expect(result.status).toBe('needs_verification');
 expect(c.beforeMutation.mock.calls.map((x:unknown[])=>x[1])).toEqual(['page_keypress','tab_history']);
 expect(mockCall.mock.calls.map(x=>x[0].name)).toEqual(['page_keypress','tab_history']);
});

test('tab_open stays outside the one-tab scope',async()=>{
 mockCall.mockImplementation(async()=>reply({state:'completed',result:{}}));
 await expect(executeBrowserModule(runner(['tab_open']),binding,context(),connection)).rejects.toThrow('BROWSER_SCOPE_DENIED');
 expect(mockCall).not.toHaveBeenCalled();
});

test('direct-command inputs reach only a runner that advertises them',async()=>{
 mockCall.mockImplementation(async()=>reply({state:'completed',result:{}}));
 await executeBrowserModule(runner([]),binding,context({command:true,interactionContext:'ctx'}),connection);
 expect((globalThis as any).__browserInput.command).toBeUndefined();
 await executeBrowserModule(runner([],['direct_command']),binding,context({command:true,interactionContext:'ctx'}),connection);
 expect((globalThis as any).__browserInput).toMatchObject({command:true,interactionContext:'ctx'});
});

// Session b01a566f: "Waiting for browser approval" flashed on every command although the grant was approved.
test('an already approved grant reports no consent wait',async()=>{
 mockCall.mockImplementation(async({name})=>reply(name==='browser_request_access'?{state:'approved'}:{state:'completed',result:{}}));
 const c=context({requestConsent:true});
 await executeBrowserModule(runner([]),binding,c,connection);
 expect(mockCall.mock.calls.map(x=>x[0].name)).toContain('browser_request_access');
 expect(c.progress.mock.calls.filter((x:any[])=>x[0].phase==='waiting_consent')).toEqual([]);
});
test('a pending grant still reports the consent wait',async()=>{
 let asked=0;
 mockCall.mockImplementation(async({name})=>reply(name==='browser_request_access'?{state:asked++?'approved':'pending'}:{state:'completed',result:{}}));
 const c=context({requestConsent:true});
 await executeBrowserModule(runner([]),binding,c,connection);
 expect(c.progress.mock.calls.filter((x:any[])=>x[0].phase==='waiting_consent').length).toBeGreaterThan(0);
});
