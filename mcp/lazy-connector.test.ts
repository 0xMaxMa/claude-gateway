import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('connector discovery defers schemas and preserves calls, rich results and errors',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lazy-connector-test-'));
 const fixture=join(dir,'upstream.ts');
 writeFileSync(fixture,`
 import {Server} from '${import.meta.dir}/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
 import {StdioServerTransport} from '${import.meta.dir}/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
 import {ListToolsRequestSchema,CallToolRequestSchema} from '${import.meta.dir}/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
 const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
 s.setRequestHandler(ListToolsRequestSchema,async r=>({tools:[{name:r.params?.cursor?'tool_search':'page_screenshot',description:'Capture browser image',inputSchema:{type:'object',properties:{tabId:{type:'number'}},required:['tabId']}}],...(!r.params?.cursor?{nextCursor:'second'}:{})}));
 s.setRequestHandler(CallToolRequestSchema,async (r,extra)=>{if(r.params.arguments?.tabId===99)await new Promise(resolve=>extra.signal.addEventListener('abort',resolve,{once:true}));return r.params.arguments?.tabId===42?{content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}],structuredContent:{tabId:42}}:{isError:true,content:[{type:'text',text:'TAB_ACCESS_DENIED'}]};});
 await s.connect(new StdioServerTransport());
 `);
 writeFileSync(join(dir,'config.json'),JSON.stringify({command:'bun',args:[fixture]}),{mode:0o600});
 const c=new Client({name:'test',version:'1'});
 try{
  await c.connect(new StdioClientTransport({command:'bun',args:[join(import.meta.dir,'lazy-connector.ts'),join(dir,'config.json')],stderr:'pipe'}));
  expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['tool_search','tool_call']);
  const search:any=await c.callTool({name:'tool_search',arguments:{name:'page_screenshot'}});
  expect(JSON.parse(search.content[0].text).tools[0].inputSchema.required).toEqual(['tabId']);
  const image:any=await c.callTool({name:'tool_call',arguments:{name:'page_screenshot',arguments:{tabId:42}}});
  expect(image.content[0]).toEqual({type:'image',mimeType:'image/png',data:'aGVsbG8='});expect(image.structuredContent).toEqual({tabId:42});
  const denied:any=await c.callTool({name:'tool_call',arguments:{name:'page_screenshot',arguments:{tabId:7}}});expect(denied.isError).toBe(true);expect(denied.content[0].text).toBe('TAB_ACCESS_DENIED');
  const missing:any=await c.callTool({name:'tool_call',arguments:{name:'unknown',arguments:{}}});expect(missing.isError).toBe(true);
  const abort=new AbortController();
  const pending=c.callTool({name:'tool_call',arguments:{name:'page_screenshot',arguments:{tabId:99}}},undefined,{signal:abort.signal});
  const timer=setTimeout(()=>abort.abort(),50);
  try{await expect(pending).rejects.toThrow();}finally{clearTimeout(timer);}
  const after:any=await c.callTool({name:'tool_call',arguments:{name:'page_screenshot',arguments:{tabId:42}}});expect(after.content[0].type).toBe('image');
  const reserved:any=await c.callTool({name:'tool_search',arguments:{name:'tool_search'}});expect(JSON.parse(reserved.content[0].text).total).toBe(1);
 }finally{await c.close();rmSync(dir,{recursive:true,force:true});}
},15000);

test('HTTP connector preserves authorization headers and original tool arguments',async()=>{
 const {createServer}=await import('http');
 const {Server}=await import('@modelcontextprotocol/sdk/server/index.js');
 const {StreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
 const {ListToolsRequestSchema,CallToolRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
 const upstream=new Server({name:'http-fixture',version:'1'},{capabilities:{tools:{}}});
 upstream.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'get_page',description:'Read page',inputSchema:{type:'object'}}]}));
 upstream.setRequestHandler(CallToolRequestSchema,async req=>({content:[{type:'text',text:JSON.stringify(req.params.arguments)}]}));
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID()});await upstream.connect(transport);
 let authorized=0;const http=createServer((req,res)=>{if(req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401).end();return;}authorized++;void transport.handleRequest(req,res);});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(join(tmpdir(),'lazy-http-'));writeFileSync(join(dir,'config.json'),JSON.stringify({type:'http',url:`http://127.0.0.1:${(http.address() as any).port}/mcp`,headers:{Authorization:'Bearer fixture-secret'}}));
 const client=new Client({name:'test',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:'bun',args:[join(import.meta.dir,'lazy-connector.ts'),join(dir,'config.json')],stderr:'pipe'}));
  const search:any=await client.callTool({name:'tool_search',arguments:{name:'get_page'}});expect(JSON.parse(search.content[0].text).total).toBe(1);
  const result:any=await client.callTool({name:'tool_call',arguments:{name:'get_page',arguments:{tab:42}}});expect(JSON.parse(result.content[0].text)).toEqual({tab:42});expect(authorized).toBeGreaterThan(1);
 }finally{await client.close();await upstream.close();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
},15000);
