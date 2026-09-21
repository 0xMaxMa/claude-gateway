import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanCodexTrace, CodexTraceState } from '../../../src/session/codex-tool-capture';
import { TurnUsageCollector } from '../../../src/orchestration/token-usage';
let root: string, dir: string, state: CodexTraceState;
beforeEach(() => { root=mkdtempSync(join(tmpdir(),'codex-schema-test-'));dir=join(root,'trace-1234');mkdirSync(join(dir,'payloads'),{recursive:true});state={files:{},pending:[],calls:{}}; });
afterEach(() => rmSync(root,{recursive:true,force:true}));
function event(payload: any) { appendFileSync(join(dir,'trace.jsonl'),JSON.stringify({schema_version:1,payload})+'\n'); }
function body(id:number,data:any) {writeFileSync(join(dir,'payloads',id+'.json'),JSON.stringify(data));}
test('captures actual schemas and per-request usage without keeping raw prompt or response', () => {
 body(1,{model:'gpt-test',input:['private prompt'],tools:[{type:'function',name:'exec_command'},{type:'namespace',name:'mcp__docs',tools:[{name:'search'},{name:'hidden',defer_loading:true}]}]});
 event({type:'inference_started',inference_call_id:'request-1',request_payload:{path:'payloads/1.json'}});
 body(2,{token_usage:{input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:20,output_tokens:7},output_items:['private answer']});
 event({type:'inference_completed',inference_call_id:'request-1',response_payload:{path:'payloads/2.json'}});
 const result=scanCodexTrace(root,state); const collector=new TurnUsageCollector();
 for(const value of result.measurements){if(value.schemas)collector.observeSchemas(value.schemas);if(value.request)collector.observe({type:'assistant',message:value.request});}
 expect(collector.snapshot()).toMatchObject({contextTools:['exec_command','mcp__docs__search'],schemaCoverage:{measured:1,total:1},usage:{inputTokens:40,cacheReadTokens:40,cacheCreationTokens:20,outputTokens:7,totalTokens:107}});
 expect(JSON.stringify(result)).not.toMatch(/private prompt|private answer/);
 expect(existsSync(join(dir,'payloads/1.json'))).toBe(false);expect(existsSync(join(dir,'payloads/2.json'))).toBe(false);
 expect(scanCodexTrace(root,state).measurements).toEqual([]);
});
test('keeps schemas visible before completion and retries incomplete payload writes', () => {
 event({type:'inference_started',inference_call_id:'request-2',request_payload:{path:'payloads/1.json'}});
 expect(scanCodexTrace(root,state).measurements).toEqual([]);
 body(1,{tools:[{name:'exec_command'}]});
 const result=scanCodexTrace(root,state);const collector=new TurnUsageCollector();collector.observeSchemas(result.measurements[0].schemas!);
 expect(collector.snapshot()).toMatchObject({contextTools:['exec_command'],requests:[],usage:null});
});
test('rejects payload traversal and cleans unrelated tool-result payloads', () => {
 body(1,{secret:'tool result'});
 event({type:'tool_call_ended',result_payload:{path:'payloads/1.json'}});
 event({type:'inference_started',inference_call_id:'request-3',request_payload:{path:'../outside.json'}});
 expect(scanCodexTrace(root,state).measurements).toEqual([]);
 expect(existsSync(join(dir,'payloads/1.json'))).toBe(false);
});
test('captures Code Mode declarations and inherits schemas for response continuations', () => {
 body(1,{model:'gpt-test',input:[{type:'additional_tools',tools:[{type:'namespace',name:'functions',tools:[{name:'exec',description:'Available: not_loaded.\n```ts\ndeclare const tools: { exec_command(args: {}): Promise<unknown>; };\n```'}]}]}]});
 event({type:'inference_started',inference_call_id:'code-1',request_payload:{path:'payloads/1.json'}});
 body(2,{response_id:'resp_1',token_usage:{input_tokens:10,output_tokens:1}});
 event({type:'inference_completed',inference_call_id:'code-1',response_payload:{path:'payloads/2.json'}});
 body(3,{previous_response_id:'resp_1',input:[]});
 event({type:'inference_started',inference_call_id:'code-2',request_payload:{path:'payloads/3.json'}});
 const schemas=scanCodexTrace(root,state).measurements.flatMap(m=>m.schemas?[m.schemas]:[]);
 expect(schemas).toHaveLength(2);
 expect(schemas.map(s=>s.loaded)).toEqual([['exec_command','functions__exec'],['exec_command','functions__exec']]);
});
test('missing schema metadata is unknown, not an empty measured inventory', () => {
 body(1,{input:[],previous_response_id:'unknown'});
 event({type:'inference_started',inference_call_id:'unknown',request_payload:{path:'payloads/1.json'}});
 expect(scanCodexTrace(root,state).measurements).toEqual([]);
});
test('does not follow a symlinked payload directory or remove its contents', () => {
 const fs=require('fs');const outside=join(root,'outside');fs.renameSync(join(dir,'payloads'),outside);fs.symlinkSync(outside,join(dir,'payloads'));
 body(1,{tools:[{name:'stolen'}]});
 event({type:'inference_started',inference_call_id:'unsafe',request_payload:{path:'payloads/1.json'}});
 expect(scanCodexTrace(root,state).measurements).toEqual([]);
 expect(existsSync(join(outside,'1.json'))).toBe(true);
});
test.each([{tools:[{name:'replacement'}]}, {tools:[]}])('explicit tools replace inherited schemas: %j', ({tools}) => {
 body(1,{tools:[{name:'old'},{name:'deferred',defer_loading:true}]});
 event({type:'inference_started',inference_call_id:'r1',request_payload:{path:'payloads/1.json'}});
 body(2,{response_id:'resp_1'});
 event({type:'inference_completed',inference_call_id:'r1',response_payload:{path:'payloads/2.json'}});
 body(3,{previous_response_id:'resp_1',tools,input:[{type:'tool_reference',tool_name:'deferred'}]});
 event({type:'inference_started',inference_call_id:'r2',request_payload:{path:'payloads/3.json'}});
 const schemas=scanCodexTrace(root,state).measurements.flatMap(m=>m.schemas?[m.schemas]:[]);
 expect(schemas[1]).toMatchObject({loaded:tools.map(t=>t.name),deferred:[]});
});
