import { spawn } from 'child_process';
import { resolve } from 'path';
import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import { containerTaskTools } from '../../../src/orchestration/container-tool-schemas';
function listTools(role: 'agent' | 'worker', enabled: boolean): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bun', [resolve('mcp/server.ts')], { env: {
      PATH: process.env.PATH, HOME: process.env.HOME, GATEWAY_ORCHESTRATION_ROLE: role,
      GATEWAY_ORCHESTRATION_TICKET_FILE: '/inventory-only-no-execution', GATEWAY_JEV_ENABLED: enabled ? 'true' : '',
      IMAGE_DISABLED: 'true', VIDEO_DISABLED: 'true',
    }, stdio: ['pipe','pipe','pipe'] });
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
test.each(['agent','worker'] as const)('real host MCP %s inventory gates Jev for both native harnesses', async role => {
  expect(await listTools(role,false)).not.toContain('jev_evaluate');
  expect(await listTools(role,true)).toContain('jev_evaluate');
});
test.each([false,true])('container init inventory validates captured Jev enablement=%s', async enabled => {
  class Process extends EventEmitter {
    runtimeProfile = { role: 'worker' as const, containerExecution: true, jevEnabled: enabled, mcpConfigPath: '', overlay: '' };
    managedGroupStopped = false; managedProcessId = undefined; spawnedAt = Date.now();
    async start() {}
    interrupt() { return true; }
    async stop() { this.managedGroupStopped = true; }
    sendMessage() {
      this.emit('output',JSON.stringify({type:'system',subtype:'init',tools:containerTaskTools('worker',true).map(t=>'mcp__gateway__'+t.name)}));
      this.emit('output',JSON.stringify({type:'result',result:'Verified fixture'}));
    }
  }
  const process = new Process(); const turn = startProcessTurn(process,'test',1000);
  if(enabled) await expect(turn.result).resolves.toMatchObject({text:'Verified fixture'});
  else await expect(turn.result).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH',rejectedTools:['mcp__gateway__jev_evaluate']});
  await process.stop();
});
