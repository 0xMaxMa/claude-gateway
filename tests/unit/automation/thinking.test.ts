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
