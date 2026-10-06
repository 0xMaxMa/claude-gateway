const {thinkJson}=require('../../../lib/automation/thinking.cjs');

// A 2000-character Thai field value: the helper contract allows it, so the
// output budget and the provider's auth header must not reject it.
const thai='ก'.repeat(2000);
function provider(envelope:unknown){
 return jest.fn(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify(envelope),{headers:{'content-type':'application/json'}}));
}
const run=(api:'openai-chat'|'anthropic-messages',fetcher:jest.Mock)=>thinkJson({api,baseUrl:'https://model.example/v1',model:'small',apiKey:'fixture-key'},{instruction:'Return {"text":string|null}',input:{goal:'x'}},new AbortController().signal,fetcher);

test('M8: anthropic-messages authenticates with x-api-key and leaves room for a 2000-character Thai value',async()=>{
 const fetcher=provider({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({text:thai})}]});
 await expect(run('anthropic-messages',fetcher)).resolves.toMatchObject({output:{text:thai}});
 const [url,init]=fetcher.mock.calls[0];const headers=init.headers as Record<string,string>;
 expect(url).toBe('https://model.example/v1/messages');
 expect(headers['x-api-key']).toBe('fixture-key');expect(headers.Authorization).toBeUndefined();
 expect(JSON.parse(String(init.body)).max_tokens).toBeGreaterThanOrEqual(4096);
});
test('M8: openai-chat keeps Bearer authentication and the same output budget',async()=>{
 const fetcher=provider({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'ok'})}}]});
 await run('openai-chat',fetcher);
 const init=fetcher.mock.calls[0][1];const headers=init.headers as Record<string,string>;
 expect(headers.Authorization).toBe('Bearer fixture-key');expect(headers['x-api-key']).toBeUndefined();
 expect(JSON.parse(String(init.body)).max_tokens).toBe(4096);
});

test('anthropic-messages with authScheme bearer sends Authorization: Bearer and no x-api-key',async()=>{
 const fetcher=provider({stop_reason:'end_turn',content:[{type:'text',text:'{"text":"ok"}'}]});
 await thinkJson({api:'anthropic-messages',baseUrl:'https://model.example/v1',model:'small',apiKey:'fixture-key',authScheme:'bearer'},{instruction:'x',input:{}},new AbortController().signal,fetcher);
 const headers=fetcher.mock.calls[0][1].headers as Record<string,string>;
 expect(headers.Authorization).toBe('Bearer fixture-key');expect(headers['x-api-key']).toBeUndefined();
 expect(headers['anthropic-version']).toBe('2023-06-01');
});

// Real fetch against a loopback server: nothing is mocked in the transport. A real getpod proxy is NOT exercised here.
describe('real fetch against a loopback HTTP server',()=>{
 const http=require('node:http') as typeof import('node:http');
 let server:import('node:http').Server,base='',seen:Array<{url:string;headers:Record<string,string|string[]|undefined>;body:string}>=[],handler:(req:any,res:any)=>void;
 beforeAll(async()=>{
  server=http.createServer((req,res)=>{let body='';req.on('data',(c:Buffer)=>{body+=c;});req.on('end',()=>{seen.push({url:req.url??'',headers:req.headers,body});handler(req,res);});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
 });
 afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
 beforeEach(()=>{seen=[];});
 const ok=(res:any,payload:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));};
 const call=(authScheme?:'x-api-key'|'bearer')=>thinkJson({api:'anthropic-messages',baseUrl:base+'/v1',model:'small',apiKey:'fixture-key',...(authScheme?{authScheme}:{})},{instruction:'x',input:{a:1}},new AbortController().signal);
 const good={stop_reason:'end_turn',content:[{type:'text',text:'{"text":"ok"}'}]};
 test('x-api-key by default and Bearer when requested, on the wire',async()=>{
  handler=(_q,res)=>ok(res,good);
  await expect(call()).resolves.toMatchObject({output:{text:'ok'}});
  await expect(call('bearer')).resolves.toMatchObject({output:{text:'ok'}});
  expect(seen[0].url).toBe('/v1/messages');
  expect(seen[0].headers['x-api-key']).toBe('fixture-key');expect(seen[0].headers.authorization).toBeUndefined();
  expect(seen[1].headers.authorization).toBe('Bearer fixture-key');expect(seen[1].headers['x-api-key']).toBeUndefined();
  expect(seen[1].headers['anthropic-version']).toBe('2023-06-01');
 });
 test('redirects are refused (redirect:error) and never followed',async()=>{
  handler=(_q,res)=>{res.writeHead(302,{location:base+'/elsewhere'});res.end();};
  await expect(call()).rejects.toBeTruthy();
  expect(seen.map(s=>s.url)).toEqual(['/v1/messages']);
 });
 test('response body over 64 KiB is rejected',async()=>{
  handler=(_q,res)=>ok(res,{stop_reason:'end_turn',content:[{type:'text',text:'x'.repeat(70000)}]});
  await expect(call()).rejects.toThrow('THINKING_INVALID_RESPONSE');
 });
 test('oversized input is rejected before any request is sent',async()=>{
  const big=()=>thinkJson({api:'anthropic-messages',baseUrl:base+'/v1',model:'small',apiKey:'k'},{instruction:'x',input:{a:'y'.repeat(70000)}},new AbortController().signal);
  await expect(big()).rejects.toThrow('THINKING_INVALID_INPUT');
  expect(seen).toHaveLength(0);
 });
});
