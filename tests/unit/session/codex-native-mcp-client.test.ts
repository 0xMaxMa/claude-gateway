import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { CodexNativeClient } from '../../../src/session/codex-native-mcp-client';
jest.mock('child_process', () => ({ spawn: jest.fn() }));
let child: any;
let available: Record<string, any>;
let calls: any[];
let client: CodexNativeClient;
beforeEach(() => {
  calls = []; available = { echo: { name: 'echo', inputSchema: { type: 'object' } } };
  (spawn as jest.Mock).mockImplementation(() => {
    const proc: any = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.exitCode = null; proc.signalCode = null;
    proc.kill = jest.fn(() => { proc.signalCode = 'SIGTERM'; setImmediate(() => proc.emit('close')); });
    proc.stdin.on('data', (data: Buffer) => {
      const q = JSON.parse(data.toString()); calls.push(q);
      if (q.id === undefined) return;
      const result = q.method === 'thread/start' ? { thread: { id: 'fixture-thread' } }
        : q.method === 'mcpServerStatus/list' ? { data: [{ name: 'allowed', tools: available }, { name: 'unapproved', tools: available }, { name: 'offline', toolsError: 'unavailable' }] }
        : q.method === 'mcpServer/tool/call' ? { content: [{ type: 'text', text: 'done' }] } : {};
      setImmediate(() => proc.stdout.write(JSON.stringify({ id: q.id, result }) + '\n'));
    });
    child = proc; return proc;
  });
  client = new CodexNativeClient({ bin: 'codex', cwd: '/tmp', home: '/tmp/codex', servers: ['allowed', 'offline'] });
});
afterEach(async () => { await client.close(); jest.clearAllMocks(); });
test('authorizes only selected server tools and never starts a model turn', async () => {
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['allowed__echo']);
  await client.callTool({ name: 'allowed__echo' });
  await expect(client.callTool({ name: 'unapproved__echo' })).rejects.toThrow('Discover');
  expect(calls.some(c => c.method === 'turn/start')).toBe(false);
  expect(client.getInstructions()).toContain('Unavailable servers: offline');
});
test('refresh removes stale tools before allowing subsequent calls', async () => {
  await client.listTools(); available = {};
  expect((await client.listTools()).tools).toEqual([]);
  await expect(client.callTool({ name: 'allowed__echo' })).rejects.toThrow('Discover');
});
test('connection exit invalidates catalog and reconnects for discovery without replaying mutations', async () => {
  const changed = jest.fn(); client.setNotificationHandler({}, changed);
  await client.listTools(); child.exitCode = 1; child.emit('close');
  await expect(client.callTool({ name: 'allowed__echo' })).rejects.toThrow('Discover');
  await client.listTools(); await client.callTool({ name: 'allowed__echo' });
  expect(changed).toHaveBeenCalled(); expect(spawn).toHaveBeenCalledTimes(2);
  expect(calls.filter(c => c.method === 'mcpServer/tool/call')).toHaveLength(1);
});
