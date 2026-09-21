import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
  test('real MCP never loads legacy safemode schemas for agents or workers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'safemode-mcp-'));
    const calls: Array<{ tool: string; args: unknown }> = [];
    let allow = false;
    const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      calls.push(await req.json()); return allow ? Response.json({ allowed: true }) : new Response('ACCESS_DENIED', { status: 403 });
    } });
    const ticket = join(directory, 'ticket.json');
    writeFileSync(ticket, JSON.stringify({ url: `http://127.0.0.1:${bridge.port}`, token: 'synthetic-test' }));
    const clients: Client[] = [];
    try {
      for (const [role, permittedTools] of [['agent',true],['agent',false],['worker',true]] as const) {
        const client = new Client({ name: 'safemode-test', version: '1' }); clients.push(client);
        await client.connect(new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, '../../server.ts')], stderr: 'ignore', env: {
          PATH: process.env.PATH ?? '', HOME: directory, GATEWAY_ORCHESTRATION_ROLE: role, GATEWAY_SAFEMODE_ALLOWED: permittedTools ? 'true' : '', GATEWAY_ORCHESTRATION_TICKET_FILE: ticket,
        } }));
        const listed = (await client.listTools()).tools.filter(tool => tool.name.startsWith('safemode_'));
        expect(listed).toEqual([]);
        expect((await client.callTool({name:'safemode_list',arguments:{}})).isError).toBe(true);
      }
      expect(calls).toHaveLength(0);
    } finally { for (const client of clients) await client.close(); bridge.stop(true); rmSync(directory, { recursive: true, force: true }); }
  }, 15000);
