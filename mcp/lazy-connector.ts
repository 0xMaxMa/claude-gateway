#!/usr/bin/env bun
/** A worker-local MCP adapter. Only discovery/call schemas enter the model;
 * upstream authorization, arguments and rich results remain unchanged. */
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLazyToolCatalog, LAZY_TOOL_DEFINITIONS } from './lazy-tools';
import { CodexNativeClient } from '../dist/session/codex-native-mcp-client.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client: any = config.nativeCodex ? new CodexNativeClient(config.nativeCodex) : new Client({name:'gateway-lazy-connector',version:'1'});
const shutdown = new AbortController();
let connection: Promise<void> | undefined;
let catalog: ReturnType<typeof createLazyToolCatalog> | undefined;
let loading: Promise<ReturnType<typeof createLazyToolCatalog>> | undefined;
function connect(): Promise<void> {
  if (!connection) connection = (async()=>{
    if (config.nativeCodex) { await client.connect(); return; }
    const transport = config.command ? new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...config.env},cwd:config.cwd,stderr:'inherit'})
      : config.type === 'sse' ? new SSEClientTransport(new URL(config.url),{requestInit:{headers:config.headers}})
      : new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}});
    await client.connect(transport,{timeout:10000});
  })().catch(async error=>{connection=undefined;await client.close().catch(()=>{});throw error;});
  return connection;
}
client.setNotificationHandler(ToolListChangedNotificationSchema,async()=>{catalog=undefined;});
async function discover() {
  if(catalog)return catalog;
  if(!loading)loading=(async()=>{
    await connect();
    const tools:any[]=[];const cursors=new Set<string>();let cursor:string|undefined;let pages=0;let bytes=0;
    do {
      if(++pages>500)throw Error('Connector catalog pagination exceeded page limit');
      const page=await client.listTools(cursor?{cursor}:{},{timeout:10000,signal:shutdown.signal});
      const pageTools=page.tools.filter(t => (!Array.isArray(config.enabled_tools) || config.enabled_tools.includes(t.name)) && !config.disabled_tools?.includes(t.name)).map(t=>({...t,description:t.description??''}));
      bytes+=Buffer.byteLength(JSON.stringify(pageTools));
      if(tools.length+pageTools.length>10000||bytes>8*1024*1024)throw Error('Connector catalog too large');
      tools.push(...pageTools);
      cursor=page.nextCursor;
      if(cursor&&cursors.has(cursor))throw Error('Invalid catalog pagination');
      if(cursor)cursors.add(cursor);
    }while(cursor);
    return catalog=createLazyToolCatalog(tools, false);
  })().finally(()=>{loading=undefined;});
  return loading;
}
const server = new Server({name:'gateway-lazy-connector',version:'1'},{capabilities:{tools:{}},instructions:'This connector supports on-demand tools. Call tool_search to discover capabilities and original argument schemas, then tool_call with the exact returned name and arguments. Search does not execute actions. All tools remain subject to the original connector permissions.'});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:LAZY_TOOL_DEFINITIONS.map(t=>({...t,description:t.description.replaceAll('gateway','connector').replace(' Task reporting and memory retrieval remain directly available.','')}))}));
server.setRequestHandler(CallToolRequestSchema,async(req,extra)=>{
  if(!['tool_search','tool_call'].includes(req.params.name))return {isError:true,content:[{type:'text',text:'Discover this connector with tool_search, then use tool_call.'}]};
  try {
    const tools=await discover();const args=req.params.arguments??{};
    if(req.params.name==='tool_search'){
      const result=tools.search(args);
      if(!result.isError){const data=JSON.parse(result.content[0].text);data.instructions=client.getInstructions();result.content[0].text=JSON.stringify(data);}
      return result;
    }
    return await tools.call(args,async(name,input)=>await client.callTool({name,arguments:input},undefined,{signal:AbortSignal.any([extra.signal,shutdown.signal]),timeout:600000,onprogress:progress=>{const token=req.params._meta?.progressToken;if(token!==undefined)void server.notification({method:'notifications/progress',params:{...progress,progressToken:token}}).catch(()=>{});}}) as any);
  }catch(error){console.error('[gateway-lazy-connector] tool call failed:',error);return {isError:true,content:[{type:'text',text:shutdown.signal.aborted||extra.signal.aborted?'Connector call cancelled.':'Connector request failed. Check the connector connection and permissions. Do not repeat a mutation without checking whether it succeeded.'}]};}
});
await server.connect(new StdioServerTransport());
let closing=false;
async function close(){if(closing)return;closing=true;shutdown.abort();await client.close().catch(()=>{});await server.close().catch(()=>{});process.exit(0);}
process.stdin.on('end',close);process.stdin.on('close',close);process.on('SIGINT',close);process.on('SIGTERM',close);
