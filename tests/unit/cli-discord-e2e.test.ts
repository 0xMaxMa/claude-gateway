import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscordModule } from '../../mcp/tools/discord/module';
import { cliPairingStore } from '../../src/cli-viewer/pairing-store';

/**
 * Discord `/cli` end-to-end (mocked): drive the REAL message + interaction
 * handlers through an injected fake discord.js client. A `/cli` DM must render an
 * open-viewer Link button + an Approve button, and tapping Approve must flip the
 * pairing to approved. The runner callback is emulated by a fetch stub that talks
 * to the real CliPairingStore, so the assertion is on real store state.
 */

const AGENT = 'agent-disc';
const USER = 'user-123';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// Emulate the runner's /command callback against the real store.
function installCallbackStub(): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { command: string; payload: Record<string, unknown> };
    if (body.command === 'cli_pair') {
      const { pairingId, code } = cliPairingStore.create(AGENT, 'discord', String(body.payload['user_id']));
      return jsonResponse({ success: true, pairingId, code, url: `https://host.example/cli/${pairingId}` });
    }
    if (body.command === 'cli_approve') {
      const pid = String(body.payload['pairing_id']);
      const uid = String(body.payload['user_id']);
      const result = body.payload['deny'] === true
        ? cliPairingStore.deny(pid, 'discord', uid)
        : cliPairingStore.approve(pid, 'discord', uid);
      return jsonResponse({ success: result === 'ok', result });
    }
    return jsonResponse({ success: false });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeFakeClient(): EventEmitter & { user: unknown; channels: unknown } {
  const c = new EventEmitter() as EventEmitter & { user: unknown; channels: unknown };
  c.user = { id: 'bot-1' };
  c.channels = { fetch: async () => ({}), cache: { has: () => true } };
  return c;
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

describe('Discord /cli end-to-end (mocked client)', () => {
  let tmp: string;
  let mod: DiscordModule;
  let client: ReturnType<typeof makeFakeClient>;
  let abort: AbortController;
  let fetchMock: jest.Mock;
  const origFetch = global.fetch;
  const origEnv = { ...process.env };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-disc-'));
    fs.writeFileSync(path.join(tmp, 'access.json'), JSON.stringify({ dmPolicy: 'open' }));
    process.env.DISCORD_STATE_DIR = tmp;
    process.env.CLAUDE_CHANNEL_CALLBACK = 'http://127.0.0.1:9/channel';
    fetchMock = installCallbackStub();

    mod = new DiscordModule();
    client = makeFakeClient();
    (mod as unknown as { client: unknown }).client = client;
    abort = new AbortController();
    // start() blocks until the signal aborts — fire and forget.
    void mod.start(async () => {}, abort.signal);
    await tick(2);
  });

  afterEach(() => {
    abort.abort();
    global.fetch = origFetch;
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function dmMessage(content: string, id: string) {
    return {
      author: { id: USER, username: 'tester', bot: false },
      system: false,
      guild: null,
      channelId: 'dm-chan',
      id,
      content,
      channel: { send: jest.fn(async () => ({})) },
    };
  }

  it('/cli renders an open-viewer Link + Approve button, and Approve unlocks the pairing', async () => {
    const msg = dmMessage('/cli', 'm-1');
    client.emit('messageCreate', msg);
    await tick();

    // A cli_pair callback was made and a reply with components was sent.
    expect(fetchMock).toHaveBeenCalled();
    expect(msg.channel.send as jest.Mock).toHaveBeenCalledTimes(1);
    const sent = (msg.channel.send as jest.Mock).mock.calls[0][0] as { components: Array<{ components: Array<Record<string, unknown>> }> };
    const buttons = sent.components[0].components;
    const link = buttons.find((b) => b['style'] === 5);
    const approve = buttons.find((b) => typeof b['custom_id'] === 'string' && (b['custom_id'] as string).startsWith('cli:approve:'));
    expect(link).toBeTruthy();
    expect(String(link!['url'])).toMatch(/^https:\/\/host\.example\/cli\/[0-9a-f]{36}$/);
    expect(approve).toBeTruthy();

    const pairingId = (approve!['custom_id'] as string).slice('cli:approve:'.length);
    expect(cliPairingStore.get(pairingId)?.status).toBe('pending');

    // Tap Approve → interaction handler relays cli_approve → store flips.
    const interaction = {
      isButton: () => true,
      customId: `cli:approve:${pairingId}`,
      guildId: null,
      channelId: 'dm-chan',
      user: { id: USER, username: 'tester' },
      message: { id: 'm-1' },
      client: { user: { id: 'bot-1' } },
      reply: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    };
    client.emit('interactionCreate', interaction);
    await tick();

    expect(cliPairingStore.get(pairingId)?.status).toBe('approved');
    expect(interaction.update).toHaveBeenCalled();
  });

  it('Deny marks the pairing denied instead of approved', async () => {
    const msg = dmMessage('/cli', 'm-2');
    client.emit('messageCreate', msg);
    await tick();
    const sent = (msg.channel.send as jest.Mock).mock.calls[0][0] as { components: Array<{ components: Array<Record<string, unknown>> }> };
    const approve = sent.components[0].components.find((b) => String(b['custom_id'] ?? '').startsWith('cli:approve:'))!;
    const pairingId = (approve['custom_id'] as string).slice('cli:approve:'.length);

    const interaction = {
      isButton: () => true,
      customId: `cli:deny:${pairingId}`,
      guildId: null,
      channelId: 'dm-chan',
      user: { id: USER, username: 'tester' },
      message: { id: 'm-2' },
      client: { user: { id: 'bot-1' } },
      reply: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    };
    client.emit('interactionCreate', interaction);
    await tick();

    expect(cliPairingStore.get(pairingId)?.status).toBe('denied');
  });
});
