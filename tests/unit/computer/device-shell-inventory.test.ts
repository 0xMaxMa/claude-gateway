import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { GatewayTaskAdapter } from '../../../src/orchestration/gateway-tasks/controller';
import type { RuntimeProfile } from '../../../src/session/runtime-profile';

// Lists tools from the real MCP server under the exact env the bridge wrote to mcp.json.
function listTools(command: string, args: string[], env: Record<string, string>): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, IMAGE_DISABLED: 'true', VIDEO_DISABLED: 'true', ...env }, stdio: ['pipe','pipe','pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(Error('MCP inventory timed out')); }, 10000);
    let buffer = ''; let settled = false;
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => {
      buffer += data.toString(); let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { child.stdin.write(JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized' })+'\n'); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n'); }
        if (msg.id === 2) { settled = true; clearTimeout(timer); child.kill(); if(msg.error) reject(Error(JSON.stringify(msg.error))); else resolveResult(msg.result.tools.map((t: any) => t.name)); }
      }
    });
    child.stderr.resume();
    child.on('exit', code => { clearTimeout(timer); if (!settled) reject(Error('MCP exited before inventory response: ' + code)); });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})+'\n');
  });
}

function initTurn(profile: RuntimeProfile, tools: string[]) {
  const child = new EventEmitter() as any;
  Object.assign(child, { runtimeProfile: profile, start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    child.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools }));
    child.emit('output', JSON.stringify({ type: 'result', result: 'OK' }));
  } });
  return startProcessTurn(child, 'reply with OK', 1000).result;
}

// The agent turn that broke: the bridge declared device_shell to the MCP server while the
// init inventory check still rejected it (PROFILE_INVENTORY_MISMATCH on every agent turn).
test.each([true, false])('agent init inventory from the real MCP server passes its own profile check, Computer Use %s', async computer => {
  const root = mkdtempSync(join(tmpdir(), 'device-shell-inventory-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const adapter = { name: 'computer', discover: jest.fn(), resolve: jest.fn(), submit: jest.fn(), shell: jest.fn() } as unknown as GatewayTaskAdapter;
  const store = new OrchestrationStore(join(root, 'db'), 'operator'), tasks = new TaskService(store);
  const bridge = new TaskBridge(tasks, undefined, undefined, undefined, undefined, undefined, new Map([['computer', adapter]]));
  bridge.computerEnabled = () => computer;
  await bridge.start();
  try {
    const receipt = store.acceptInput({ scope: { agentId: 'operator', agentSessionId: 'chat', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'reply with OK' });
    const context = { ...receipt, ...new DecisionService(store).begin(receipt.conversationId, 'owner', [receipt.inputId]), principalId: 'owner', execute: true, writeMemory: false };
    const directory = join(root, 'ticket'), issued = bridge.issue({ role: 'agent', context } as Parameters<TaskBridge['issue']>[0], directory, workspace);
    const gateway = JSON.parse(readFileSync(join(directory, 'mcp.json'), 'utf8')).mcpServers.gateway;
    const tools = (await listTools(gateway.command, gateway.args, gateway.env)).map(name => `mcp__gateway__${name}`);
    expect(tools.includes('mcp__gateway__device_shell')).toBe(computer);
    expect(issued.profile.deviceShellEnabled).toBe(computer);
    await expect(initTurn(issued.profile, tools)).resolves.toMatchObject({ text: 'OK' });
    // A profile that did not declare device_shell still refuses it.
    if (computer) await expect(initTurn({ ...issued.profile, deviceShellEnabled: false }, tools)).rejects.toMatchObject({ code: 'PROFILE_INVENTORY_MISMATCH', rejectedTools: ['mcp__gateway__device_shell'] });
    issued.revoke();
  } finally { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
}, 20000);
