import { spawn } from 'child_process';
import { resolve } from 'path';

// Use an isolated environment: tool discovery must not pick up a developer's
// provider credentials, connectors, or channel tokens.
async function inventory(role: string, media: boolean, disabled = false): Promise<string[]> {
  return new Promise((resolveTools, reject) => {
    const child = spawn('bun', ['mcp/server.ts'], {
      cwd: resolve(__dirname, '../../..'),
      env: { PATH: process.env.PATH, HOME: '/tmp/gateway-inventory-fixture',
        GATEWAY_WORKSPACE_DIR: '/tmp/gateway-inventory-fixture',
        GATEWAY_ORCHESTRATION_ROLE: role, GATEWAY_ORCHESTRATION_MEDIA: String(media),
        GATEWAY_ORCHESTRATION_TICKET_FILE: '/tmp/nonexistent-fixture-ticket',
        VIDEO_BASE_URL: 'https://provider.example', VIDEO_API_KEY: 'fixture', VIDEO_DISABLED: String(disabled) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', result: string[] | undefined;
    const timeout = setTimeout(() => { child.kill(); reject(Error('MCP inventory timed out')); }, 10000);
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); result ? resolveTools(result) : reject(Error('MCP exited before tools/list')); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let response: any;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (response.id === 2) { result = response.result?.tools.map((tool: {name: string}) => tool.name); child.kill(); }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'fixture', version: '1'} } });
  });
}

test.each([
  ['worker', true, false, true], ['worker', false, false, false],
  ['worker', true, true, false], ['agent', true, false, false],
] as const)('video inventory role=%s media=%s disabled=%s', async (role, media, disabled, expected) => {
  const tools = await inventory(role, media, disabled);
  expect(tools.includes('generate_video')).toBe(expected);
  expect(tools).not.toContain('api_reply');
  expect(tools.includes('task_stage_file')).toBe(role === 'worker');
});
