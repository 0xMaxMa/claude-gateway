/**
 * Status commands must not wait on the live model catalog.
 *
 * `/session` reported "The agent is busy and did not answer in time" whenever
 * `GET /v1/models` hung: `session_info` awaited the catalog just to look up the
 * context window, and the Telegram receiver gives that callback 10 s. `/models`
 * and `GET /api/v1/models` waited on the same fetch. These drive the real
 * AgentRunner callback server and API router with a catalog fetch that never
 * settles, and require an answer well inside the receiver timeout.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { waitForCondition } from '../helpers/wait-for';

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

jest.mock('child_process', () => ({ spawn: jest.fn(() => makeMockProcess()) }));

import { AgentRunner } from '../../src/agent/runner';
import { createApiRouter } from '../../src/api/router';
import { fetchModelCatalog, resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';
import type { AgentConfig, ApiKey, GatewayConfig, ModelConfig } from '../../src/types';

const CATALOG_BASE = 'https://catalog.example.com';
const STATIC_MODELS: ModelConfig[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 200000 },
  { id: 'claude-opus-5', label: 'Opus 5', alias: 'opus', contextWindow: 1000000 },
];
/** Well under the 10 s the Telegram receiver gives a status callback. */
const ANSWER_WITHIN_MS = 1000;
const ENV_KEYS = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;

const realFetch = global.fetch;
const saved: Record<string, string | undefined> = {};
let catalogCalls = 0;
let catalogReply: (() => Promise<Response>) | null = null;

/** Real network for the runner's own callback server; the catalog request never settles unless a reply is set. */
function installCatalogFetch(): void {
  (global as unknown as { fetch: unknown }).fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(CATALOG_BASE)) {
      catalogCalls++;
      return catalogReply ? catalogReply() : new Promise(() => {}); // ignores its abort signal (#679)
    }
    return realFetch(input, init);
  };
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ANSWER_WITHIN_MS} ms`)), ANSWER_WITHIN_MS).unref()),
  ]);
  return { value, ms: Date.now() - started };
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
  process.env.ANTHROPIC_BASE_URL = CATALOG_BASE;
  resetModelCatalogCache();
  resetSettingsEnvCache();
  catalogCalls = 0;
  catalogReply = null;
  installCatalogFetch();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  resetModelCatalogCache();
  resetSettingsEnvCache();
  jest.restoreAllMocks();
});

describe('AgentRunner status callbacks with a hung model catalog', () => {
  let tmpDir: string;
  let runner: AgentRunner | undefined;
  const chatId = '4242';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-hung-'));
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    runner = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startRunner(): Promise<number> {
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
    return (runner as unknown as { callbackPort: number }).callbackPort;
  }

  async function command(port: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.json() as Record<string, unknown>;
  }

  /** An active session with measured context use, so session_info has to size its window. */
  async function seedActiveSession(model: string): Promise<void> {
    const store = (runner as unknown as { sessionStore: import('../../src/session/store').SessionStore }).sessionStore;
    const meta = await store.createTelegramSession('test-agent', chatId, 'work');
    await store.setActiveSession('test-agent', chatId, meta.id);
    await store.updateSessionMeta('test-agent', chatId, meta.id, { lastInputTokens: 50000, model });
  }

  it('answers session_info from the configured context window while the catalog fetch hangs', async () => {
    const port = await startRunner();
    await seedActiveSession('claude-opus-5');

    const first = await timed(command(port, { command: 'session_info', chat_id: chatId }));
    expect(first.value.success).toBe(true);
    // 50K of the configured 1M window: sized without waiting on the catalog.
    expect(String(first.value.text)).toContain('50K / 1M · 5%');

    // A second press is not queued behind the hung request either.
    const second = await timed(command(port, { command: 'session_info', chat_id: chatId }));
    expect(second.value.success).toBe(true);
  }, 15000);

  it('answers the get_models picker with the configured list while the catalog fetch hangs', async () => {
    const port = await startRunner();

    const { value } = await timed(command(port, { command: 'get_models' }));
    expect((value.models as Array<{ id: string }>).map((m) => m.id)).toEqual(STATIC_MODELS.map((m) => m.id));
  }, 15000);

  it('answers /models on a channel while the catalog fetch hangs', async () => {
    const port = await startRunner();
    const forward = path.join(tmpDir, 'agents', 'test-agent', 'workspace', '.discord-state', 'typing', `${chatId}.forward`);

    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/models', meta: { chat_id: chatId, message_id: '1', user: 'u', source: 'discord', chat_type: 'direct', ts: new Date().toISOString() } }),
    });
    await timed(waitForCondition(() => fs.existsSync(forward), ANSWER_WITHIN_MS));
    const entries = JSON.parse(fs.readFileSync(forward, 'utf8')) as Array<{ text: string }>;
    expect(entries[entries.length - 1]!.text).toContain('Opus 5');
  }, 15000);

  it('shows live-only models once a background refresh has landed', async () => {
    catalogReply = async () => new Response(JSON.stringify({ data: [{ id: 'live-only', display_name: 'Live Only', context_window: 400000 }] }), { status: 200 });
    const port = await startRunner();

    // Refreshes in the background, so a later read sees what the catalog returned.
    await waitForCondition(async () => {
      const { value } = await timed(command(port, { command: 'get_models' }));
      return (value.models as Array<{ id: string }>).some((m) => m.id === 'live-only');
    }, 5000);
    expect(catalogCalls).toBe(1);
  }, 15000);
});

describe('GET /api/v1/models with a hung model catalog', () => {
  it('answers from the configured list instead of waiting on the fetch', async () => {
    const apiKeys: ApiKey[] = [{ key: 'sk-test', agents: ['a'] }];
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(new Map() as never, new Map() as never, apiKeys, undefined, STATIC_MODELS));

    const { value } = await timed(Promise.resolve(request(app).get('/api/v1/models').set({ Authorization: 'Bearer sk-test' })));
    expect(value.status).toBe(200);
    expect(value.body.models.map((m: { id: string }) => m.id)).toEqual(STATIC_MODELS.map((m) => m.id));
  });
});

describe('catalog deadline', () => {
  it('releases a caller of a hung fetch before the 10 s receiver callback timeout', async () => {
    jest.useFakeTimers();
    try {
      let settled = false;
      void fetchModelCatalog(STATIC_MODELS).then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(8_000);
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
