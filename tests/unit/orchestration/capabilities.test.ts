import {
  CapabilityCatalog,
  probeMcpConfiguration,
  readCapabilityPage,
} from '../../../src/orchestration/capabilities';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
import type { SkillRegistry } from '../../../src/skills';
import { tmpdir } from 'os';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskBridge } from '../../../src/orchestration/bridge';

test('CLI discovery reads metadata only and preserves plugin MCP configuration privately', async () => {
  const script = `require('readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); const type=m.request.subtype;
    if(m.type!=='control_request'||!['initialize','mcp_status'].includes(type))process.exit(2);
    process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:type==='initialize'?{}:{mcpServers:[{name:'plugin-demo',config:{type:'http',url:'https://private.test',headers:{Authorization:'private-secret'}}},{name:'gateway',config:{command:'never'}}]}}})+'\\n');
  });`;
  const result = await probeMcpConfiguration(
    process.execPath,
    ['-e', script],
    tmpdir()
  );
  expect(Object.keys(result)).toEqual(['plugin-demo']);
});

test('catalog pagination retains every tool and all automatic/shared/native skills', () => {
  const snapshot = {
    observedAt: 'now',
    servers: [{ name: 'demo', status: 'available' }],
    entries: Array.from({ length: 123 }, (_, i) => ({
      name: `mcp__demo__tool_${i}`,
      description: 'A useful tool',
      server: 'demo',
      status: 'available',
      via: 'worker',
    })),
  };
  const registry = {
    skills: new Map([
      [
        'automatic',
        {
          description: 'Automatic skill',
          source: 'shared',
          userInvocable: false,
        },
      ],
    ]),
    cliSkills: [{ name: 'code-review', description: 'Native review' }],
  } as unknown as SkillRegistry;
  const entries = [];
  let offset: number | null = 0;
  let version: string | undefined;
  do {
    const page = readCapabilityPage(snapshot, registry, {
      offset,
      catalog_version: version,
    });
    version = page.catalog_version;
    entries.push(...page.entries);
    offset = page.next_offset;
  } while (offset !== null);
  expect(entries).toHaveLength(125);
  expect(() =>
    readCapabilityPage(
      { ...snapshot, entries: snapshot.entries.slice(1) },
      registry,
      { offset: 50, catalog_version: version }
    )
  ).toThrow('Restart pagination');
  expect(entries.find((e) => e.name === 'automatic')).toMatchObject({
    status: 'automatic_only',
  });
  expect(
    readCapabilityPage(snapshot, registry, { query: 'code-review' }).entries
  ).toHaveLength(1);
  expect(() =>
    readCapabilityPage(snapshot, registry, { offset: -1 })
  ).toThrow();
});

test('app and disabled agents never inspect host MCP or connector configuration', async () => {
  const gateway = {
    gateway: new Proxy({ jev: undefined }, { get(target, key) {
      if (key === 'jev') return target.jev;
      throw Error('HOST_CONFIGURATION_READ');
    } }),
  } as unknown as GatewayConfig;
  const app = await new CapabilityCatalog(
    { id: 'app', type: 'app-agent' } as AgentConfig,
    gateway
  ).snapshot();
  expect(app.entries.some((e) => e.name === 'Bash')).toBe(true);
  expect(JSON.stringify(app)).not.toMatch(
    /generate_image|browser_|host-secret/
  );
  const disabled = await new CapabilityCatalog(
    { id: 'off', allow_tools: false } as AgentConfig,
    gateway
  ).snapshot();
  expect(disabled.entries).toEqual([]);
});

test('scoped catalog is read-only, does not require execution permission, and rejects revoked tickets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-bridge-'));
  const store = new OrchestrationStore(':memory:', 'a'),
    tasks = new TaskService(store),
    bridge = new TaskBridge(tasks);
  try {
    const input = store.acceptInput({
      scope: {
        agentId: 'a',
        agentSessionId: 's',
        source: 'api',
        accountId: 'u',
        principalId: 'u',
        chatId: 'c',
        threadKey: '',
      },
      text: 'List your tools',
    });
    const decision = new DecisionService(store).begin(
      input.conversationId,
      'u',
      [input.inputId]
    );
    await bridge.start();
    const metadata = jest.fn(async () => ({
      entries: [{ name: 'image', via: 'worker' }],
    }));
    const ticket = bridge.issue(
      {
        role: 'agent',
        context: {
          ...input,
          ...decision,
          principalId: 'u',
          execute: false,
          writeMemory: false,
        },
        capabilities: metadata,
      },
      join(root, 'ticket'),
      root
    );
    const auth = JSON.parse(
      readFileSync(join(root, 'ticket/ticket.json'), 'utf8')
    );
    const call = () =>
      fetch(auth.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'capabilities_list',
          args: {},
          action_id: 'read',
        }),
      });
    expect(await (await call()).json()).toMatchObject({
      executionAllowedForThisTurn: false,
      entries: [{ name: 'image', via: 'worker' }],
    });
    expect(store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
    ticket.revoke();
    expect((await call()).status).toBe(403);
    expect(metadata).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real MCP metadata discovery follows all pages without invoking tools or exposing configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-mcp-'));
  try {
    const fixture = join(root, 'fixture.cjs'),
      log = join(root, 'methods');
    writeFileSync(
      fixture,
      `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},m.method+'\\n');if(m.id===undefined)return;
      const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:m.params?.cursor?'second':'first',description:'Metadata only',inputSchema:{type:'object'}}],...(m.params?.cursor?{}:{nextCursor:'page2'})}:{};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`
    );
    const input = JSON.stringify({
      observed: [
        {
          name: 'oauth',
          status: 'connected',
          tools: [{ name: 'known_tool', description: '' }],
        },
      ],
      servers: {
        oauth: {
          type: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { Authorization: 'private-secret' },
        },
        offline: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
        old_agent: {
          command: 'bun',
          args: [resolve('mcp/server.ts')],
          env: {
            GATEWAY_ORCHESTRATION_ROLE: 'agent',
            GATEWAY_ORCHESTRATION_TICKET_FILE: '/not-a-valid-ticket',
            GATEWAY_CAPABILITY_CATALOG: '',
          },
        },
        new_agent: {
          command: 'bun',
          args: [resolve('mcp/server.ts')],
          env: {
            GATEWAY_ORCHESTRATION_ROLE: 'agent',
            GATEWAY_ORCHESTRATION_TICKET_FILE: '/not-a-valid-ticket',
            GATEWAY_CAPABILITY_CATALOG: 'true',
          },
        },
        fixture: {
          command: process.execPath,
          args: [fixture],
          env: { FIXTURE_SECRET: 'private-secret' },
        },
      },
    });
    const runner = join(root, 'runner.ts');
    // Input is piped privately; no credentials in command arguments or output.
    writeFileSync(
      runner,
      `const p=Bun.spawn(['bun',${JSON.stringify(resolve('mcp/capability-catalog.ts'))}],{stdin:'pipe',stdout:'pipe',stderr:'ignore'});p.stdin.write(${JSON.stringify(input)});p.stdin.end();const out=await new Response(p.stdout).text();await p.exited;process.stdout.write(out);`
    );
    const { stdout } = await promisify(execFile)('bun', [runner], {
      timeout: 15000,
      env: { ...process.env, GATEWAY_WORKSPACE_DIR: root },
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    expect(result.servers).toContainEqual({
      name: 'oauth',
      status: 'available_names_only',
    });
    expect(
      result.entries.some(
        (e: { name: string }) => e.name === 'mcp__oauth__known_tool'
      )
    ).toBe(true);
    expect(result.servers).toContainEqual({
      name: 'offline',
      status: 'discovery_unavailable',
    });
    expect(
      result.entries.some(
        (e: { name: string }) => e.name === 'mcp__new_agent__capabilities_list'
      )
    ).toBe(true);
    expect(
      result.entries.some(
        (e: { name: string }) => e.name === 'mcp__old_agent__capabilities_list'
      )
    ).toBe(false);
    expect(
      result.entries.find(
        (e: { name: string }) => e.name === 'mcp__gateway__share_file'
      )
    ).toMatchObject({ status: 'available', via: 'worker' });
    expect(
      result.entries.find(
        (e: { name: string }) => e.name === 'mcp__gateway__memory_shared_create'
      )
    ).toMatchObject({ status: 'requires_memory_permission' });
    expect(
      result.entries
        .filter((e: { server: string }) => e.server === 'fixture')
        .map((e: { name: string }) => e.name)
    ).toEqual(['mcp__fixture__first', 'mcp__fixture__second']);
    expect(stdout).not.toContain('private-secret');
    expect(stdout).not.toContain(fixture);
    expect(readFileSync(log, 'utf8')).not.toContain('tools/call');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skill metadata cannot claim execution when its declared gateway tool is restricted', () => {
  const snapshot = {observedAt:'now',servers:[],entries:[{name:'mcp__gateway__list_apps',description:'Apps',server:'gateway',status:'not_exposed_to_workers',via:'unavailable'}]};
  const registry = {skills:new Map([['apps:list-apps',{description:'List apps',source:'module',userInvocable:true,allowedTools:['mcp__gateway__list_apps']}]]),cliSkills:[]} as unknown as SkillRegistry;
  const page=readCapabilityPage(snapshot,registry,{});
  expect(page.entries.find(e=>e.name==='apps:list-apps')).toMatchObject({status:'tool_access_limited',via:'unavailable'});
});
