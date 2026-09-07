/**
 * AgentRunner's WhatsApp multi-account lifecycle (Phase 1 of the WhatsApp
 * feature-parity plan): `whatsapp: WhatsAppManager | null` became
 * `whatsappAccounts: Map<accountId, WhatsAppManager>`.
 *
 * WhatsAppManager is mocked at the module boundary — this is about which
 * managers the runner creates, keeps, and tears down as config changes, not
 * about Baileys (tests/unit/whatsapp-manager.test.ts covers that).
 *
 * The invariant that matters most: a config edit must NEVER tear down and
 * rebuild a manager whose account is unchanged, because rebuilding one drops a
 * live, linked WhatsApp socket.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FakeManager {
  accountId: string;
  agentConfig: unknown;
  stop: jest.Mock;
  unlink: jest.Mock;
  resumeIfLinked: jest.Mock;
  sendMessage: jest.Mock;
  startLinking: jest.Mock;
  requestPairingCode: jest.Mock;
  getStatus: jest.Mock;
  updateAgentConfig: jest.Mock;
}

const built: FakeManager[] = [];

jest.mock('../../src/whatsapp/manager', () => ({
  WhatsAppManager: jest.fn().mockImplementation((agentConfig: unknown, accountId: string) => {
    const m: FakeManager = {
      accountId,
      agentConfig,
      stop: jest.fn(),
      unlink: jest.fn(async () => {}),
      resumeIfLinked: jest.fn(async () => {}),
      sendMessage: jest.fn(async () => {}),
      startLinking: jest.fn(async () => {}),
      requestPairingCode: jest.fn(async () => 'ABCD-1234'),
      getStatus: jest.fn(() => ({ status: 'linked', phoneNumber: `num-${accountId}` })),
      updateAgentConfig: jest.fn(function (this: FakeManager, cfg: unknown) {
        this.agentConfig = cfg;
      }),
    };
    built.push(m);
    return m;
  }),
}));

jest.mock('child_process', () => ({ spawn: jest.fn(() => { throw new Error('no spawn in this suite'); }) }));

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig, WhatsAppAccountConfig } from '../../src/types';

let tmpDir: string;

function makeAgentConfig(accounts?: WhatsAppAccountConfig[]): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace: path.join(tmpDir, 'alfred', 'workspace'),
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    ...(accounts ? { whatsapp: { accounts } } : {}),
  };
}

const gatewayConfig: GatewayConfig = {
  gateway: { logDir: '/tmp/test-ar-wa-logs', timezone: 'UTC' },
  agents: [],
};

/** The runner's live manager map (private — this suite is about its contents). */
function managers(runner: AgentRunner): Map<string, FakeManager> {
  return (runner as unknown as { whatsappAccounts: Map<string, FakeManager> }).whatsappAccounts;
}

describe('AgentRunner — WhatsApp account map', () => {
  let runner: AgentRunner;

  beforeEach(() => {
    built.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ar-wa-'));
    fs.mkdirSync(path.join(tmpDir, 'alfred', 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await runner?.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts one manager per configured account', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'default' }, { id: 'work' }]), gatewayConfig);
    await runner.start();

    expect([...managers(runner).keys()]).toEqual(['default', 'work']);
    expect(runner.getWhatsAppAccountIds()).toEqual(['default', 'work']);
    // Each is resumed, not left idle — a linked session reconnects on boot.
    for (const m of built) expect(m.resumeIfLinked).toHaveBeenCalledTimes(1);
  });

  it("starts a lone 'default' manager for an agent with no whatsapp config", async () => {
    // Pre-multi-account behavior: a manager was constructed unconditionally,
    // so an agent that never configured WhatsApp is still linkable.
    runner = new AgentRunner(makeAgentConfig(), gatewayConfig);
    await runner.start();
    expect([...managers(runner).keys()]).toEqual(['default']);
  });

  it('adds a manager for a new account without disturbing the existing ones', async () => {
    const cfg = makeAgentConfig([{ id: 'default' }]);
    runner = new AgentRunner(cfg, gatewayConfig);
    await runner.start();
    const original = managers(runner).get('default')!;

    runner.updateAgentConfig({ ...cfg, whatsapp: { accounts: [{ id: 'default' }, { id: 'work' }] } });

    expect([...managers(runner).keys()]).toEqual(['default', 'work']);
    // Same object, never stopped: the linked socket survives the config edit.
    expect(managers(runner).get('default')).toBe(original);
    expect(original.stop).not.toHaveBeenCalled();
  });

  it('stops and drops a manager whose account left the config', async () => {
    const cfg = makeAgentConfig([{ id: 'default' }, { id: 'work' }]);
    runner = new AgentRunner(cfg, gatewayConfig);
    await runner.start();
    const work = managers(runner).get('work')!;

    runner.updateAgentConfig({ ...cfg, whatsapp: { accounts: [{ id: 'default' }] } });

    expect([...managers(runner).keys()]).toEqual(['default']);
    // stop(), never unlink(): removing an account from config must not wipe a
    // session on disk. The DELETE route unlinks explicitly, first.
    expect(work.stop).toHaveBeenCalledTimes(1);
    expect(work.unlink).not.toHaveBeenCalled();
  });

  it('pushes an access-control edit into live managers without rebuilding any', async () => {
    const cfg = makeAgentConfig([{ id: 'default' }, { id: 'work' }]);
    runner = new AgentRunner(cfg, gatewayConfig);
    await runner.start();
    const before = [...managers(runner).values()];

    const next = { ...cfg, whatsapp: { accounts: [{ id: 'default' }, { id: 'work', dmPolicy: 'open' as const }] } };
    runner.updateAgentConfig(next);

    expect([...managers(runner).values()]).toEqual(before);
    expect(built).toHaveLength(2); // no third manager was constructed
    for (const m of before) expect(m.updateAgentConfig).toHaveBeenCalledWith(next);
  });

  it('is a no-op when a config update leaves the WhatsApp block untouched', async () => {
    const cfg = makeAgentConfig([{ id: 'default' }]);
    runner = new AgentRunner(cfg, gatewayConfig);
    await runner.start();

    runner.updateAgentConfig({ ...cfg, description: 'renamed' });

    expect(built).toHaveLength(1);
    expect(managers(runner).get('default')!.stop).not.toHaveBeenCalled();
  });

  it('routes status/link/pairing/unlink/send to the named account', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'default' }, { id: 'work' }]), gatewayConfig);
    await runner.start();
    const work = managers(runner).get('work')!;
    const def = managers(runner).get('default')!;

    expect(runner.getWhatsAppStatus('work')).toMatchObject({ phoneNumber: 'num-work' });
    await runner.startWhatsAppLinking('work');
    await runner.requestWhatsAppPairingCode('+15551234567', 'work');
    await runner.unlinkWhatsApp('work');
    await runner.sendWhatsAppMessage('66811110000@s.whatsapp.net', 'hi', undefined, 'work');

    expect(work.startLinking).toHaveBeenCalledTimes(1);
    expect(work.requestPairingCode).toHaveBeenCalledWith('+15551234567');
    expect(work.unlink).toHaveBeenCalledTimes(1);
    // The trailing argument is the Phase-2 send-options bag (quote / send as
    // document / ack-clear) — undefined here because this caller passes none.
    expect(work.sendMessage).toHaveBeenCalledWith('66811110000@s.whatsapp.net', 'hi', undefined, undefined);
    expect(def.startLinking).not.toHaveBeenCalled();
    expect(def.sendMessage).not.toHaveBeenCalled();
  });

  it("defaults to 'default' when no account is named", async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'work' }, { id: 'default' }]), gatewayConfig);
    await runner.start();

    await runner.sendWhatsAppMessage('66811110000@s.whatsapp.net', 'hi');
    expect(managers(runner).get('default')!.sendMessage).toHaveBeenCalledTimes(1);
    expect(managers(runner).get('work')!.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the only account when there is no "default"', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'work' }]), gatewayConfig);
    await runner.start();

    await runner.sendWhatsAppMessage('66811110000@s.whatsapp.net', 'hi');
    expect(managers(runner).get('work')!.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicitly named account the agent does not have', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'default' }]), gatewayConfig);
    await runner.start();

    await expect(
      runner.sendWhatsAppMessage('66811110000@s.whatsapp.net', 'hi', undefined, 'ghost'),
    ).rejects.toThrow(/ghost/);
  });

  it('replies from the account an inbound message arrived on', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'default' }, { id: 'work' }]), gatewayConfig);
    await runner.start();
    const chatId = '66811110000@s.whatsapp.net';

    // The /channel POST WhatsAppManager makes carries account_id in meta; the
    // runner remembers it per chat so an unattributed reply still goes back
    // out through the right number.
    const port = (runner as unknown as { callbackPort: number }).callbackPort;
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        meta: {
          source: 'whatsapp',
          chat_id: chatId,
          message_id: '1',
          user: chatId,
          account_id: 'work',
          ts: new Date().toISOString(),
        },
      }),
    });

    await runner.sendWhatsAppMessage(chatId, 'reply');
    expect(managers(runner).get('work')!.sendMessage).toHaveBeenCalledWith(chatId, 'reply', undefined, undefined);
    expect(managers(runner).get('default')!.sendMessage).not.toHaveBeenCalled();
  });

  it('stop() tears down every manager', async () => {
    runner = new AgentRunner(makeAgentConfig([{ id: 'default' }, { id: 'work' }]), gatewayConfig);
    await runner.start();
    const all = [...managers(runner).values()];

    await runner.stop();

    for (const m of all) expect(m.stop).toHaveBeenCalledTimes(1);
    expect(managers(runner).size).toBe(0);
  });
});
