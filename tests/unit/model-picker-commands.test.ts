/**
 * Model picker on channels without an inline keyboard (issue #409).
 *
 * Two defects meet here:
 *
 *  1. `/models` existed only for Telegram, whose receiver answers it with a
 *     button keyboard of its own. Discord and LINE had no picker at all.
 *  2. `/model` was already declared for Discord in BUILTIN_COMMANDS but had no
 *     branch in handleSessionCommand — so the gate intercepted it, the closed
 *     if/else chain matched nothing, and the user got **silence**. A command
 *     listed but not handled is worse than one not listed, because the
 *     not-listed case at least reaches the agent.
 *
 * These drive the real AgentRunner through its channel callback and read what
 * comes back out — the `.forward` queue for Discord, LineReplyManager for LINE.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitFor } from '../helpers/wait-for';

// ── Mock child_process (the runner spawns a CLI we never want here) ──────────

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
import { SessionStore } from '../../src/session/store';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';

// ── Helpers ─────────────────────────────────────────────────────────────────

const STATIC_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 200000 },
  { id: 'claude-opus-5', label: 'Opus 5', alias: 'opus', contextWindow: 200000 },
];

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'test-agent',
    description: 'test agent',
    workspace,
    env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: { logDir, timezone: 'UTC', models: [...STATIC_MODELS] },
    agents: [],
  } as unknown as GatewayConfig;
}

function callbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

async function postChannelMessage(
  port: number, chatId: string, content: string, source: string,
  extraMeta: Record<string, string> = { chat_type: 'direct' },
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      meta: {
        chat_id: chatId, message_id: '1', user: 'testuser', source,
        ts: new Date().toISOString(), ...extraMeta,
      },
    }),
  });
}

const ENV_KEYS = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;

describe('AgentRunner — /models and /model on Discord and LINE (issue #409)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let runner: AgentRunner;
  let configPath: string;
  const realFetch = global.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  const chatId = 'chat:model-picker';

  // The typing/forward dir is channel-scoped: Discord's receiver polls
  // .discord-state, Telegram's .telegram-state.
  function forwardFile(state = '.discord-state'): string {
    return path.join(agentConfig.workspace, state, 'typing', `${chatId}.forward`);
  }

  function forwardText(): string {
    const entries = JSON.parse(fs.readFileSync(forwardFile(), 'utf8')) as Array<{ text: string }>;
    return entries[entries.length - 1]!.text;
  }

  async function waitForForward(): Promise<void> {
    await waitFor(() => fs.existsSync(forwardFile()), 8000);
  }

  function persistedModel(): string {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents[0].claude.model;
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
    resetModelCatalogCache();
    resetSettingsEnvCache();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-picker-'));
    const workspace = path.join(tmpDir, 'agents', 'test-agent', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    agentConfig = makeAgentConfig(workspace);
    // persistModelToConfig resolves workspace/../../../config.json
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { models: STATIC_MODELS },
      agents: [{ id: 'test-agent', claude: { model: 'claude-sonnet-4-6' } }],
    }, null, 2));
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    resetModelCatalogCache();
    resetSettingsEnvCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function startRunner(): Promise<number> {
    runner = new AgentRunner(agentConfig, makeGatewayConfig(path.join(tmpDir, 'logs')));
    await runner.start();
    return callbackPort(runner);
  }

  it('answers /models on Discord with the list and the current model marked', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/models', 'discord');
    await waitForForward();

    const text = forwardText();
    expect(text).toContain('Current model: claude-sonnet-4-6');
    expect(text).toContain('Sonnet 4.6');
    expect(text).toContain('Opus 5');
    expect(text).toContain('✅');           // the one in use is marked
    expect(text).toContain('/model ');      // and the list says how to pick
  }, 15000);

  it('answers /model on Discord instead of swallowing it', async () => {
    // The regression: /model was gated for Discord with no dispatch branch, so
    // the message was intercepted and then silently dropped.
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model', 'discord');
    await waitForForward();

    expect(forwardText()).toContain('Current model: claude-sonnet-4-6');
  }, 15000);

  it('switches and persists the model chosen by alias', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model opus', 'discord');
    await waitForForward();

    expect(forwardText()).toContain('claude-opus-5');
    expect(persistedModel()).toBe('claude-opus-5');
  }, 15000);

  // #460: config.json carries agent bot tokens and the admin API key.
  // persistModelToConfig()'s tmp-then-rename pattern silently downgraded it
  // from 0600 to the tmp file's default mode (0644) on every model switch.
  it('keeps config.json at 0600 after a model switch, even though it started at the fixture\'s default mode', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model opus', 'discord');
    await waitForForward();

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  }, 15000);

  // #460 (independent review, round 3): persistModelToConfig() writes to a
  // FIXED tmp path (`config.json.tmp`), not a unique one — writeFileSync's
  // `mode` option is silently ignored when that path already exists (e.g.
  // left behind by a prior crashed write), so an explicit chmodSync is
  // required after the write, not just the mode option on it.
  it('still ends up at 0600 even when a stale .tmp file from a prior crashed write is already sitting at the fixed tmp path', async () => {
    fs.writeFileSync(configPath + '.tmp', 'stale leftover', { mode: 0o644 });

    const port = await startRunner();
    await postChannelMessage(port, chatId, '/model opus', 'discord');
    await waitForForward();

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  }, 15000);

  it('restarts the running session so the new model actually takes effect', async () => {
    // setModel only rewrites config. The session process was spawned with the
    // old model on its command line, so without a restart "Model set to X" is
    // a false success and the next turn still runs the previous model. The
    // Telegram picker's set_model path has always restarted; the channel
    // command has to do the same.
    const port = await startRunner();
    const restarted: string[] = [];
    const priv = runner as unknown as {
      sessions: Map<string, { source: string }>;
      restartProcess: (key: string) => Promise<void>;
    };
    priv.sessions.set(chatId, { source: 'discord' });
    priv.restartProcess = async (key: string) => { restarted.push(key); };

    await postChannelMessage(port, chatId, '/model opus', 'discord');
    await waitForForward();

    expect(restarted).toEqual([chatId]);
    expect(forwardText()).toContain('Restarting');
    priv.sessions.delete(chatId); // keep teardown off the fake session
  }, 15000);

  it('refuses to switch models from a group chat', async () => {
    // /model <x> rewrites config.json for the whole agent and restarts every
    // session in every chat. Discord's guild gate checks guild, channel and
    // mention — never the user — so any member of an allowlisted channel could
    // otherwise switch the model out from under everyone and kill their turns.
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model opus', 'discord', { chat_type: 'group' });
    await waitForForward();

    expect(forwardText()).toContain('direct message');
    expect(persistedModel()).toBe('claude-sonnet-4-6');
  }, 15000);

  it('fails closed when the channel reports no chat type at all', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model opus', 'discord', {});
    await waitForForward();

    expect(persistedModel()).toBe('claude-sonnet-4-6');
  }, 15000);

  it('still lists models in a group chat — reading changes nothing', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/models', 'discord', { chat_type: 'group' });
    await waitForForward();

    expect(forwardText()).toContain('Sonnet 4.6');
  }, 15000);

  it('accepts LINE 1:1 chats, which report their kind as "user"', async () => {
    const port = await startRunner();
    const answers: string[] = [];
    (runner as unknown as { lineReply: unknown }).lineReply = {
      onInbound: jest.fn(),
      onAnswer: (_id: string, text: string) => { answers.push(text); },
      disposeAll: jest.fn(),
    };

    await postChannelMessage(port, chatId, '/model opus', 'line', { line_chat_type: 'user' });
    await waitFor(() => answers.length > 0, 8000);

    expect(persistedModel()).toBe('claude-opus-5');
  }, 15000);

  it('can still switch back to a configured model the live catalog omits', async () => {
    // The catalog replaces the list rather than merging, so a configured model
    // upstream does not list vanishes from /models. Without keeping it
    // *addressable*, a user who moves to a live-only model is trapped there.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }) };
      }
      return realFetch(url as never, init as never);
    });
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model opus', 'discord');
    await waitForForward();

    expect(persistedModel()).toBe('claude-opus-5');
  }, 15000);

  it('refuses an unknown model rather than persisting a typo into config.json', async () => {
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model claude-opus-500', 'discord');
    await waitForForward();

    expect(forwardText()).toContain('Unknown model');
    expect(persistedModel()).toBe('claude-sonnet-4-6');
  }, 15000);

  it('routes the LINE picker through LineReplyManager, which has no .forward consumer', async () => {
    const port = await startRunner();
    const answers: Array<{ chatId: string; text: string }> = [];
    (runner as unknown as { lineReply: unknown }).lineReply = {
      onInbound: jest.fn(),
      onAnswer: (id: string, text: string) => { answers.push({ chatId: id, text }); },
      disposeAll: jest.fn(), // runner.stop() calls this during teardown
    };

    await postChannelMessage(port, chatId, '/models', 'line');
    await waitFor(() => answers.length > 0, 8000);

    expect(answers[0].chatId).toBe(chatId);
    expect(answers[0].text).toContain('Sonnet 4.6');
    // LINE must not also get a .forward file — nothing on that channel reads it.
    expect(fs.existsSync(forwardFile())).toBe(false);
    expect(fs.existsSync(forwardFile('.telegram-state'))).toBe(false);
  }, 15000);

  // ── the live catalog reaching the picker ──────────────────────────────────

  it('lists the live catalog, not the static list, when a base URL is configured', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }) };
      }
      return realFetch(url as never, init as never);
    });
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/models', 'discord');
    await waitForForward();

    const text = forwardText();
    expect(text).toContain('Some BYOK Model');
    expect(text).toContain('Configured models');
    expect(text).toContain('More models (live)');
    expect(text).toContain('Sonnet 4.6');
  }, 15000);

  it('selects and persists a model that exists only in the live catalog', async () => {
    // AC3 — a model outside the static/fallback list must still round-trip.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }) };
      }
      return realFetch(url as never, init as never);
    });
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/model byok/some-model', 'discord');
    await waitForForward();

    expect(forwardText()).toContain('byok/some-model');
    expect(persistedModel()).toBe('byok/some-model');
  }, 15000);

  it('keeps a configured model\'s real context window when the catalog omits it', async () => {
    // The catalog replaces the list, so a configured model upstream does not
    // list is absent from it. Falling straight to DEFAULT_CONTEXT_WINDOW there
    // reports /session context use against a fifth of the real window and
    // hands SessionCompactor a window small enough to compact far too early.
    const bigModel = { id: 'local-1m', label: 'Local 1M', alias: 'local1m', contextWindow: 1000000 };
    agentConfig.claude.model = bigModel.id;
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) {
        // Upstream knows nothing about the locally-configured 1M id.
        return { ok: true, json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }) };
      }
      return realFetch(url as never, init as never);
    });

    runner = new AgentRunner(agentConfig, {
      gateway: { logDir: path.join(tmpDir, 'logs'), timezone: 'UTC', models: [...STATIC_MODELS, bigModel] },
      agents: [],
    } as unknown as GatewayConfig);
    await runner.start();

    // Channel-scoped: /session reads the index for the inbound channel, so the
    // meta has to be written under 'discord', not the store's 'telegram' default.
    const store = new SessionStore(path.resolve(agentConfig.workspace, '..', '..'));
    const index = await store.getOrCreateIndex(agentConfig.id, chatId, 'discord');
    await store.updateSessionMeta(agentConfig.id, chatId, index.activeSessionId, {
      lastInputTokens: 50000, name: 'ctx', messageCount: 3,
    }, 'discord');

    await postChannelMessage(callbackPort(runner), chatId, '/session', 'discord');
    await waitForForward();

    // 50000 / 1000000 = 5%. Against the 200k default it would read 25%.
    expect(forwardText()).toContain('5%');
    expect(forwardText()).not.toContain('25%');
  }, 15000);

  // ── get_models: the HTTP command the Telegram receiver's keyboard calls ────
  // Distinct code path from the channel picker above — that one calls
  // availableModels() in-process, this one answers a POST from the receiver
  // process. Reverting only one of them leaves the other green, so both need
  // their own coverage.

  async function getModelsOverHttp(port: number): Promise<Array<{ id: string; label: string }>> {
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get_models' }),
    });
    return ((await res.json()) as { models: Array<{ id: string; label: string }> }).models;
  }

  it('get_models answers with the live catalog when one is configured', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    const catalogFetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }) };
      }
      return realFetch(url as never, init as never);
    });
    (global as unknown as { fetch: unknown }).fetch = catalogFetch;
    const port = await startRunner();

    const models = await getModelsOverHttp(port);

    expect(models).toEqual([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'byok/some-model', label: 'Some BYOK Model' },
    ]);
  }, 15000);

  it('get_models answers with the static list when the catalog is unreachable', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    const catalogFetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) throw new Error('ECONNREFUSED');
      return realFetch(url as never, init as never);
    });
    (global as unknown as { fetch: unknown }).fetch = catalogFetch;
    const port = await startRunner();

    const models = await getModelsOverHttp(port);

    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'claude-opus-5']);
  }, 15000);

  it('falls back to the static list when the catalog cannot be reached', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).endsWith('/v1/models')) throw new Error('ECONNREFUSED');
      return realFetch(url as never, init as never);
    });
    const port = await startRunner();

    await postChannelMessage(port, chatId, '/models', 'discord');
    await waitForForward();

    expect(forwardText()).toContain('Sonnet 4.6');
  }, 15000);
});
