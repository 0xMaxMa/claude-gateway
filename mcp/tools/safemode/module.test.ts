import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafemodeModule, SAFEMODE_TOOLS } from './module';

const originalRole = process.env.GATEWAY_ORCHESTRATION_ROLE;
afterEach(() => {
  if (originalRole === undefined) delete process.env.GATEWAY_ORCHESTRATION_ROLE;
  else process.env.GATEWAY_ORCHESTRATION_ROLE = originalRole;
});
describe('safemode MCP facade', () => {
  test('strict argv preserves prompt text and never implies takeover', async () => {
    process.env.GATEWAY_ORCHESTRATION_ROLE = 'agent';
    const commands: string[][] = [];
    const mod = new SafemodeModule(async args => { commands.push(args); return { stdout: '{"accepted":true}', failed: false }; });
    const prompt = '--dangerously-bypass-approvals-and-sandbox $(touch /tmp/no)';
    expect((await mod.handleTool('safemode_send', { session: 'diagnosis', prompt, request_id: 'request-1' })).isError).toBeUndefined();
    expect(commands[0]).toEqual(['send', 'diagnosis', `--prompt=${prompt}`, '--request-id=request-1']);
    await mod.handleTool('safemode_send', { session: 'diagnosis', prompt: 'continue', request_id: 'request-2', takeover: true });
    expect(commands[1].at(-1)).toBe('--takeover');
  });
  test('invalid roles, flags and unknown fields cannot reach execution', async () => {
    let calls = 0;
    const mod = new SafemodeModule(async () => { calls++; return { stdout: '{}', failed: false }; });
    for (const role of ['worker', '']) {
      process.env.GATEWAY_ORCHESTRATION_ROLE = role;
      expect((await mod.handleTool('safemode_list', {})).isError).toBe(true);
    }
    process.env.GATEWAY_ORCHESTRATION_ROLE = 'agent';
    for (const [tool, args] of [
      ['safemode_status', { session: '--config' }], ['safemode_list', { command: 'sh' }],
      ['safemode_send', { session: 'debug', prompt: 'inspect', request_id: 'r', takeover: 'true' }],
      ['safemode_send', { session: 'debug', prompt: 'inspect', request_id: '--option' }],
      ['safemode_delete', { session: 'debug' }],
    ] as Array<[string, Record<string, unknown>]>) expect((await mod.handleTool(tool, args)).isError).toBe(true);
    expect(calls).toBe(0);
  });
  test('bounded command errors do not echo executable error containing a prompt', async () => {
    process.env.GATEWAY_ORCHESTRATION_ROLE = 'agent';
    const mod = new SafemodeModule(async () => { throw Error('command contains PRIVATE_PROMPT'); });
    const result = await mod.handleTool('safemode_list', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('PRIVATE_PROMPT');
  });
  test('real MCP lists agent schemas, denies revoked ticket, and hides tools from workers', async () => {
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
      for (const role of ['agent', 'worker']) {
        const client = new Client({ name: 'safemode-test', version: '1' }); clients.push(client);
        await client.connect(new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, '../../server.ts')], stderr: 'ignore', env: {
          PATH: process.env.PATH ?? '', HOME: directory, GATEWAY_ORCHESTRATION_ROLE: role, GATEWAY_ORCHESTRATION_TICKET_FILE: ticket,
        } }));
        const listed = (await client.listTools()).tools.filter(tool => tool.name.startsWith('safemode_'));
        if (role === 'worker') expect(listed).toEqual([]);
        else {
          expect(listed).toEqual(SAFEMODE_TOOLS);
          const result = await client.callTool({ name: 'safemode_list', arguments: {} });
          expect(result.isError).toBe(true);
          expect((result.content as Array<{ text: string }>)[0].text).toBe('ACCESS_DENIED');
          allow = true;
          const permitted = await client.callTool({ name: 'safemode_list', arguments: {} });
          expect(permitted.isError).not.toBe(true);
          expect(JSON.parse((permitted.content as Array<{ text: string }>)[0].text)).toEqual([]);
        }
      }
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call).toEqual({ tool: 'safemode_validate', args: { operation: 'list' }, action_id: expect.any(String) });
    } finally { for (const client of clients) await client.close(); bridge.stop(true); rmSync(directory, { recursive: true, force: true }); }
  }, 15000);
});
