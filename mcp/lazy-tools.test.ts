import { describe, test, expect } from 'bun:test';
import { createLazyToolCatalog } from './lazy-tools';
import type { McpToolDefinition } from './types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defs: McpToolDefinition[] = Array.from({ length: 23 }, (_, i) => ({ name: `tool_${String(i).padStart(2, '0')}`, description: `Original description ${i}`,
  inputSchema: { type: 'object', properties: { target: { type: 'string', enum: ['a', 'b'] } }, required: ['target'], additionalProperties: false } }));
const parse = (r: ReturnType<ReturnType<typeof createLazyToolCatalog>['search']>) => JSON.parse(r.content[0].text);

describe('lazy gateway tools', () => {
  test('bounded discovery lists all metadata and exact original schemas on demand', () => {
    const catalog = createLazyToolCatalog(defs);
    const index = parse(catalog.search({ limit: 20 }));
    expect(index.total).toBe(23); expect(index.next_offset).toBe(20);
    expect(index.tools[0]).toEqual({ name: defs[0].name, description: defs[0].description });
    expect(parse(catalog.search({ offset: 20 })).tools).toHaveLength(3);
    expect(parse(catalog.search({ name: 'TOOL_01' })).tools).toEqual([defs[1]]);
    expect(parse(catalog.search({ query: 'ORIGINAL description 22' })).tools).toEqual([defs[22]]);
    expect(catalog.search({ limit: 21 }).isError).toBe(true);
  });
  test('unauthorized, task and recursive tools never reach dispatcher', async () => {
    let calls = 0; const dispatch = async () => { calls++; return { content: [] }; };
    const catalog = createLazyToolCatalog(defs);
    for (const name of ['missing', 'task_spawn', 'tool_call', 'tool_search']) expect((await catalog.call({ name, arguments: {} }, dispatch)).isError).toBe(true);
    expect((await catalog.call({ name: 'tool_00', arguments: [] }, dispatch)).isError).toBe(true);
    expect(calls).toBe(0);
  });
  test('excludeReserved filters an underlying tool literally named tool_search/tool_call; the connector opt-out does not', async () => {
    const collision: McpToolDefinition[] = [...defs,
      { name: 'tool_search', description: 'Underlying tool that collides with the reserved name', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
    let calls = 0; const dispatch = async () => { calls++; return { content: [] }; };
    const filtered = createLazyToolCatalog(collision);
    expect(parse(filtered.search({ name: 'tool_search' })).total).toBe(0);
    expect((await filtered.call({ name: 'tool_search', arguments: {} }, dispatch)).isError).toBe(true);
    expect(calls).toBe(0);
    const unfiltered = createLazyToolCatalog(collision, false);
    expect(parse(unfiltered.search({ name: 'tool_search' })).total).toBe(1);
    expect((await unfiltered.call({ name: 'tool_search', arguments: {} }, dispatch)).isError).toBeFalsy();
    expect(calls).toBe(1);
  });
  test('preserves original arguments, validation errors and cancellation through dispatcher', async () => {
    const catalog = createLazyToolCatalog(defs), args = { target: 'invalid' };
    const denial = { isError: true, content: [{ type: 'text' as const, text: 'original validation rejected target' }] };
    expect(await catalog.call({ name: 'tool_00', arguments: args }, async (name, actual) => {
      expect(name).toBe('tool_00'); expect(actual).toBe(args); return denial;
    })).toBe(denial);
    const controller = new AbortController(); controller.abort();
    await expect(catalog.call({ name: 'tool_00', arguments: {} }, async () => { controller.signal.throwIfAborted(); return denial; })).rejects.toThrow();
  });
  test('real MCP worker facade preserves ticket validation for direct and wrapped calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-lazy-'));
    const requests: string[] = [];
    const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      requests.push((await req.json()).tool);
      return new Response('TASK_TICKET_REVOKED', { status: 403 });
    } });
    const ticket = join(dir, 'ticket.json');
    writeFileSync(ticket, JSON.stringify({ url: `http://127.0.0.1:${bridge.port}`, token: 'test-only' }));
    const client = new Client({ name: 'lazy-test', version: '1' });
    const transport = new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, 'server.ts')], stderr: 'ignore', env: {
      PATH: process.env.PATH ?? '', HOME: dir, GATEWAY_ORCHESTRATION_ROLE: 'worker', GATEWAY_ORCHESTRATION_MEDIA: 'true',
      GATEWAY_LAZY_TOOLS: 'true', GATEWAY_ORCHESTRATION_TICKET_FILE: ticket, IMAGE_DISABLED: 'true', VIDEO_DISABLED: 'true',
    } });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.some(t => t.name === 'tool_search')).toBe(true);
      expect(list.tools.some(t => t.name === 'browser_navigate')).toBe(false);
      expect(list.tools.some(t => t.name === 'task_report_progress')).toBe(true);
      const found = await client.callTool({ name: 'tool_search', arguments: { name: 'browser_navigate' } });
      expect(JSON.parse((found.content as Array<{ text: string }>)[0].text).tools[0].inputSchema).toBeDefined();
      for (const call of [{ name: 'browser_navigate', arguments: { url: 'https://example.test' } },
        { name: 'tool_call', arguments: { name: 'browser_navigate', arguments: { url: 'https://example.test' } } }]) {
        const response = await client.callTool(call);
        expect(response.isError).toBe(true);
        expect((response.content as Array<{ text: string }>)[0].text).toBe('TASK_TICKET_REVOKED');
      }
      expect(requests).toEqual(['task_validate', 'task_validate']);
    } finally { await client.close(); bridge.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});

test('real lazy inventory preserves every execution schema and successful browser behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-lazy-smoke-'));
  const browserCalls: unknown[] = [], bridgeCalls: unknown[] = [];
  const browserResult = { content: [{ type: 'text', text: JSON.stringify({ title: 'Stub page', status: 'ready' }) }] };
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    if (new URL(req.url).pathname === '/ticket') {
      bridgeCalls.push(body); return Response.json({ valid: true });
    }
    if (new URL(req.url).pathname === '/mcp') {
      browserCalls.push(body);
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: browserResult })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error('Unexpected network call: ' + req.url);
  } });
  const base = `http://127.0.0.1:${local.port}`, ticket = join(dir, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ url: base + '/ticket', token: 'synthetic-only' }));
  const common = { PATH: process.env.PATH ?? '', HOME: dir, GATEWAY_ORCHESTRATION_ROLE: 'worker', GATEWAY_ORCHESTRATION_MEDIA: 'true',
    GATEWAY_ORCHESTRATION_TICKET_FILE: ticket, GETPOD_BROWSER_URL: base, GETPOD_BROWSER_API_KEY: 'synthetic-only',
    ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'synthetic-only', GATEWAY_SESSION_ID: 'synthetic-session', GATEWAY_AGENT_ID: 'synthetic-agent' };
  const clients: Client[] = [];
  const start = performance.now();
  try {
    for (const lazy of [false, true]) {
      const client = new Client({ name: 'local-inventory-smoke', version: '1' }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, 'server.ts')], stderr: 'ignore',
        env: { ...common, GATEWAY_LAZY_TOOLS: String(lazy) } }));
    }
    const readyMs = performance.now() - start;
    const direct = (await clients[0].listTools()).tools, lazy = (await clients[1].listTools()).tools;
    const execution = direct.filter(tool => !lazy.some(other => other.name === tool.name));
    expect(execution.map(t => t.name)).toContain('generate_image');
    expect(execution.map(t => t.name)).toContain('generate_video');
    const searchStart = performance.now();
    for (const tool of execution) {
      const found = await clients[1].callTool({ name: 'tool_search', arguments: { name: tool.name } });
      const entry = JSON.parse((found.content as Array<{ text: string }>)[0].text).tools[0];
      expect(entry).toEqual(tool);
    }
    const schemaSearchMs = performance.now() - searchStart;
    const args = { url: 'https://example.test/synthetic?q=1', tab_id: 'stub-tab' };
    const directStart = performance.now();
    const a = await clients[0].callTool({ name: 'browser_navigate', arguments: args });
    const directCallMs = performance.now() - directStart;
    const wrappedStart = performance.now();
    const b = await clients[1].callTool({ name: 'tool_call', arguments: { name: 'browser_navigate', arguments: args } });
    const wrappedCallMs = performance.now() - wrappedStart;
    expect(a).toEqual(b); expect(a.isError).not.toBe(true);
    expect(a.content).toEqual(browserResult.content);
    expect(browserCalls).toHaveLength(2);
    const params = browserCalls.map(call => (call as { params: unknown }).params);
    expect(params[0]).toEqual(params[1]);
    expect(params[0]).toEqual({ name: 'browser_navigate', arguments: { ...args, session_id: 'synthetic-session', agent_id: 'synthetic-agent' } });
    expect(bridgeCalls.map(call => (call as { tool: string }).tool)).toEqual(['task_validate', 'task_validate']);
    writeFileSync('/tmp/gateway-500-lazy-schema-smoke.json', JSON.stringify({
      measuredAt: new Date().toISOString(), fixture: 'local synthetic browser and ticket bridge; no external provider/model calls',
      directToolCount: direct.length, lazyToolCount: lazy.length, deferredToolCount: execution.length,
      directSchemaBytes: Buffer.byteLength(JSON.stringify(direct)), lazySchemaBytes: Buffer.byteLength(JSON.stringify(lazy)),
      readyMs, schemaSearchMs, directCallMs, wrappedCallMs,
      note: 'Single local smoke timing, not a performance benchmark or model-level token savings measurement.',
    }, null, 2));
  } finally {
    for (const client of clients) await client.close();
    local.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('cron tools survive module registration and lazy discovery, while privileged modules remain unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-lazy-'));
  const calls: string[] = [];
  const bridge = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const body=await req.json(); calls.push(body.tool);
    return Response.json(body.tool === 'cron_list' ? {jobs:[]} : {active:true});
  }});
  const ticket=join(dir,'ticket.json');writeFileSync(ticket,JSON.stringify({url:`http://127.0.0.1:${bridge.port}`,token:'fixture'}));
  const client=new Client({name:'cron-test',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:'bun',args:[join(import.meta.dir,'server.ts')],stderr:'ignore',env:{PATH:process.env.PATH??'',HOME:dir,GATEWAY_AGENT_ID:'fixture',GATEWAY_WORKSPACE_DIR:dir,GATEWAY_ORCHESTRATION_ROLE:'worker',GATEWAY_ORCHESTRATION_MEDIA:'true',GATEWAY_ORCHESTRATION_CRON:'true',GATEWAY_ORCHESTRATION_TICKET_FILE:ticket,GATEWAY_LAZY_TOOLS:'true'}}));
    const search=await client.callTool({name:'tool_search',arguments:{query:'cron'}});
    expect(JSON.parse((search.content as any)[0].text).total).toBe(6);
    const result=await client.callTool({name:'tool_call',arguments:{name:'cron_list',arguments:{}}});
    expect(result.isError).not.toBe(true);expect(calls).toEqual(['task_validate','cron_list']);
    for(const name of ['agent_create','install_app','skill_install','api_request','telegram_send_message']){
      const denied=await client.callTool({name:'tool_call',arguments:{name,arguments:{}}});expect(denied.isError).toBe(true);
    }
  }finally{await client.close();bridge.stop(true);rmSync(dir,{recursive:true,force:true});}
},15000);

test('all registered worker modules follow the scoped execution policy',async()=>{
 const {gatewayModules}=await import('./modules');
 expect(gatewayModules('agent').map(m=>m.id)).toEqual(['memory']);
 expect(gatewayModules('worker',true).map(m=>m.id)).toEqual(['memory','cron','image','video','share-file','browser']);
 const standalone=gatewayModules().map(m=>m.id);
 for(const id of ['cron','image','video','share-file','browser','skills','apps','agent','api','telegram','discord','line','slack','whatsapp','whatsapp_cloud','wechat'])expect(standalone).toContain(id);
});
