import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/** The MCP server runs under bun; without it there is nothing to list (third review of #591, L13). */
const hasBun = spawnSync('bun', ['--version']).status === 0;

/** A temp HOME, so the server reads none of this machine's ~/.claude* state. */
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'readonly-inventory-home-')); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * Review of #591: a read-only subagent's gateway MCP server advertises only
 * tools that change nothing (the bridge also refuses the rest).
 */
function listTools(env: Record<string, string>): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bun', [resolve('mcp/server.ts')], { env: {
      PATH: process.env.PATH, HOME: home, GATEWAY_ORCHESTRATION_ROLE: 'worker',
      GATEWAY_ORCHESTRATION_TICKET_FILE: '/inventory-only-no-execution', GATEWAY_ORCHESTRATION_CRON: 'true',
      GATEWAY_ORCHESTRATION_WRITE_MEMORY: 'true', GATEWAY_SUBAGENTS: 'true', IMAGE_DISABLED: 'true', VIDEO_DISABLED: 'true', ...env,
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(Error('MCP inventory timed out')); }, 10000);
    let buffer = '', settled = false;
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => {
      buffer += data.toString(); let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'); }
        if (msg.id === 2) { settled = true; clearTimeout(timer); child.kill(); if (msg.error) reject(Error(JSON.stringify(msg.error))); else resolveResult(msg.result.tools.map((t: any) => t.name)); }
      }
    });
    child.stderr.resume();
    child.on('exit', code => { clearTimeout(timer); if (!settled) reject(Error('MCP exited before inventory response: ' + code)); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
  });
}

(hasBun ? test : test.skip)('a read-only worker keeps read tools and loses mutating ones', async () => {
  const writer = await listTools({ GATEWAY_READONLY_TASK: '' });
  expect(writer).toEqual(expect.arrayContaining(['cron_create', 'cron_list', 'task_memory_append', 'subagent_spawn', 'task_report_progress']));
  const reader = await listTools({ GATEWAY_READONLY_TASK: 'true' });
  expect(reader).toEqual(expect.arrayContaining(['cron_list', 'cron_get_runs', 'subagent_spawn', 'task_report_progress', 'task_stage_file']));
  for (const tool of ['cron_create', 'cron_update', 'cron_delete', 'cron_run', 'task_memory_append']) expect(reader).not.toContain(tool);
}, 30000);
