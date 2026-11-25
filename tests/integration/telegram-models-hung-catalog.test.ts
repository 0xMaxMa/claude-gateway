/**
 * Telegram `/models` end to end while the live model catalog hangs (#693).
 *
 * Runs the real receiver process (bun) against the real AgentRunner callback
 * server. The catalog request (`GET {ANTHROPIC_BASE_URL}/v1/models`) never
 * settles, as in #679. The receiver gives `get_models` 10 s, so `/models` must
 * still answer with the menu from the configured list, not an error.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';

interface MockChildProcess extends EventEmitter {
  stdin: { writable: boolean; write: jest.Mock } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = { writable: true, write: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn(() => { proc.killed = true; process.nextTick(() => proc.emit('exit', 0, 'SIGTERM')); return true; });
  return proc;
}

// The runner's own claude/receiver children are stubbed; the receiver under
// test is spawned with the real child_process below.
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn(() => makeMockProcess()) }));
const { spawn: realSpawn, execSync } = jest.requireActual<typeof import('child_process')>('child_process');

import { AgentRunner } from '../../src/agent/runner';
import { fetchModelCatalog, resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';
import type { AgentConfig, GatewayConfig, ModelConfig } from '../../src/types';

const RECEIVER_PATH = path.resolve(__dirname, '../../mcp/tools/telegram/receiver-server.ts');
const CATALOG_BASE = 'https://catalog.example.com';
const USER_ID = '111222333';
const STATIC_MODELS: ModelConfig[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 200000 },
  { id: 'claude-opus-5', label: 'Opus 5', alias: 'opus', contextWindow: 1000000 },
];
const ENV_KEYS = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;

const hasBun = (() => { try { execSync('bun --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Just enough Bot API for the receiver to boot, poll and send. */
function startMockTelegram(port: number) {
  const calls: Array<{ method: string; body: Record<string, unknown>; ts: number }> = [];
  const pending: object[] = [];
  let updateId = 0;
  let waiter: (() => void) | null = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop()?.split('?')[0] ?? '';
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* form or empty body */ }
      calls.push({ method, body, ts: Date.now() });
      const ok = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return ok({ id: 99999, is_bot: true, username: 'testbot', first_name: 'TestBot' });
      if (method === 'sendMessage') return ok({ message_id: 500, chat: { id: Number(body['chat_id']), type: 'private' }, text: body['text'], date: Math.floor(Date.now() / 1000) });
      if (method === 'getUpdates') {
        const deliver = () => ok(pending.splice(0).map((u) => ({ update_id: ++updateId, ...u })));
        if (pending.length) return deliver();
        const timer = setTimeout(() => { waiter = null; deliver(); }, 400);
        waiter = () => { clearTimeout(timer); waiter = null; deliver(); };
        return;
      }
      ok(true);
    });
  });
  server.listen(port, '127.0.0.1');
  return {
    calls,
    queueUpdate(update: object) { pending.push(update); waiter?.(); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const describeWithBun = hasBun ? describe : describe.skip;

describeWithBun('Telegram /models with a hung model catalog', () => {
  const realFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};
  let catalogCalls = 0;
  let tmpDir: string;
  let runner: AgentRunner;
  let telegram: ReturnType<typeof startMockTelegram>;
  let receiver: ChildProcess;

  beforeAll(async () => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
    process.env.ANTHROPIC_BASE_URL = CATALOG_BASE;
    resetModelCatalogCache();
    resetSettingsEnvCache();
    // The catalog request never settles and ignores its abort signal (#679).
    (global as unknown as { fetch: unknown }).fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(CATALOG_BASE)) { catalogCalls++; return new Promise(() => {}); }
      return realFetch(input, init);
    };
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hung-catalog-'));
    const workspace = path.join(tmpDir, 'agents', 'test-agent', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      gateway: { orchestration: false, models: STATIC_MODELS },
      agents: [{ id: 'test-agent', claude: { model: 'claude-sonnet-4-6' } }],
    }));
    const agentConfig: AgentConfig = {
      id: 'test-agent', description: 'test agent', workspace, env: '',
      telegram: { botToken: 'test-token' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    };
    const gatewayConfig = {
      gateway: { orchestration: false, logDir: path.join(tmpDir, 'logs'), timezone: 'UTC', models: [...STATIC_MODELS] },
      agents: [],
    } as unknown as GatewayConfig;
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const callbackPort = (runner as unknown as { callbackPort: number }).callbackPort;

    const stateDir = path.join(tmpDir, 'receiver-state');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [USER_ID], groups: {}, pending: {} }));
    const telegramPort = await freePort();
    telegram = startMockTelegram(telegramPort);
    receiver = realSpawn('bun', [RECEIVER_PATH], {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: 'test_token_hung_catalog',
        GATEWAY_ORCHESTRATION_ENABLED: 'false',
        TELEGRAM_STATE_DIR: stateDir,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${telegramPort}`,
        CLAUDE_CHANNEL_CALLBACK: `http://127.0.0.1:${callbackPort}/channel`,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    receiver.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jest', version: '1.0.0' } } }) + '\n');
    const deadline = Date.now() + 20_000;
    while (!telegram.calls.some((c) => c.method === 'getUpdates') && Date.now() < deadline) await sleep(50);
    if (!telegram.calls.some((c) => c.method === 'getUpdates')) throw new Error('receiver did not start polling');
  }, 45_000);

  afterAll(async () => {
    // Let the hung request reach its deadline here, so its timer does not log
    // after the suite has ended.
    await fetchModelCatalog(STATIC_MODELS);
    try { receiver?.kill('SIGTERM'); } catch { /* already gone */ }
    await runner?.stop();
    await telegram?.close();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetModelCatalogCache();
    resetSettingsEnvCache();
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers /models with the configured menu, not an error', async () => {
    const at = Date.now();
    telegram.queueUpdate({ message: {
      message_id: 1, date: Math.floor(at / 1000), text: '/models',
      from: { id: Number(USER_ID), is_bot: false, first_name: 'Tester' },
      chat: { id: Number(USER_ID), type: 'private' },
      entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    } });

    // Well under the receiver's 10 s callback timeout.
    const deadline = Date.now() + 5_000;
    const reply = () => telegram.calls.find((c) => c.method === 'sendMessage' && c.ts >= at);
    while (!reply() && Date.now() < deadline) await sleep(25);
    const sent = reply();
    expect(sent).toBeDefined();
    expect(sent!.ts - at).toBeLessThan(5_000);
    expect(String(sent!.body['text'])).toBe('Current model: claude-sonnet-4-6\nSelect a model:');
    const markup = typeof sent!.body['reply_markup'] === 'string' ? JSON.parse(sent!.body['reply_markup'] as string) : sent!.body['reply_markup'];
    const labels = (markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['✅ Sonnet 4.6', 'Opus 5', 'Dismiss']);
    // The catalog really was requested and is still hanging.
    expect(catalogCalls).toBeGreaterThan(0);
  }, 20_000);
});
