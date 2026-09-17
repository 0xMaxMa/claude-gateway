import * as fs from 'fs';
import * as path from 'path';
import { RequestToolCapture, extractToolSchemas } from '../../src/session/request-tool-capture';
import { TurnUsageCollector } from '../../src/orchestration/token-usage';

test('loaded schemas exclude deferred tools until referenced, regardless of tool usage', () => {
  const tools=[{name:'Bash'},{name:'Read',defer_loading:true},{name:'Search',defer_loading:true}];
  expect(extractToolSchemas({tools,messages:[]})).toEqual({loaded:['Bash'],deferred:['Read','Search']});
  expect(extractToolSchemas({tools,messages:[{role:'user',content:[{type:'tool_result',content:[{type:'tool_reference',tool_name:'Read'}]}]}]})).toEqual({loaded:['Bash','Read'],deferred:['Search']});
});
test('capture correlates asynchronous index with a partial request and deletes raw bodies', async () => {
 const events:any[]=[];const capture=new RequestToolCapture(v=>events.push(v));
 const file=path.join(capture.directory,'req.request.json');
 try{
  fs.writeFileSync(file,'{"tools":');fs.writeFileSync(path.join(capture.directory,'index.jsonl'),JSON.stringify({request_file:'req.request.json',message_id:'message'})+'\n');capture.scan();
  expect(events).toHaveLength(0);
  fs.writeFileSync(file,JSON.stringify({tools:[{name:'Read'},{name:'Bash'}],messages:[{content:'private text'}]}));
  fs.writeFileSync(path.join(capture.directory,'req.response.json'),'private response');capture.scan();capture.scan();
  expect(events).toEqual([{messageId:'message',requestId:'req',loaded:['Bash','Read'],deferred:[],source:'cli-request-body'}]);
  expect(fs.existsSync(file)).toBe(false);expect(fs.existsSync(path.join(capture.directory,'req.response.json'))).toBe(false);
  expect(JSON.stringify(await capture.flush())).not.toContain('private');
 }finally{capture.close();}
 expect(fs.existsSync(capture.directory)).toBe(false);
});
test('a captured request never supplies another turn with an invented Loaded count', () => {
 const first=new TurnUsageCollector(),second=new TurnUsageCollector();
 const schema={messageId:'first',requestId:'request',loaded:['Bash','Read'],deferred:[],source:'cli-request-body' as const};
 for(const c of [first,second])c.observeSchemas(schema);
 first.observe({type:'assistant',message:{id:'first',usage:{input_tokens:1,output_tokens:1}}});
 second.observe({type:'assistant',message:{id:'second',usage:{input_tokens:1,output_tokens:1}}});
 expect(first.snapshot()).toMatchObject({contextTools:['Bash','Read'],usedTools:[],schemaCoverage:{measured:1,total:1}});
 expect(second.snapshot()).toMatchObject({contextTools:null,schemaCoverage:{measured:0,total:1}});
});
