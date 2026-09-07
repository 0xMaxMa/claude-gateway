/**
 * Unit tests for WhatsAppManager (src/whatsapp/manager.ts) with Baileys
 * mocked at the module boundary — no real WhatsApp account/network needed.
 * Covers: QR vs pairing-code linking, connection-state transitions
 * (open → linked, close/loggedOut → unlinked+no-reconnect,
 * close/other → reconnecting), creds persistence, and the inbound
 * access-gate → forward-to-callback / deny → pending-sender-with-code path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig } from '../../src/types';
import { _resetPendingSenders, getPendingSenders } from '../../src/api/pending-senders';

const mockSock = {
  ev: { on: jest.fn() },
  user: { id: '66899990000:5@s.whatsapp.net' },
  // waitForSocketOpen polls this before requestPairingCode — real Baileys
  // sockets open asynchronously, but there's nothing async to wait for here.
  ws: { isOpen: true },
  sendMessage: jest.fn(async () => undefined),
  requestPairingCode: jest.fn(async () => 'ABCD-1234'),
  logout: jest.fn(async () => undefined),
  end: jest.fn(),
};
const mockSaveCreds = jest.fn(async () => undefined);
let mockRegistered = false;
const mockMakeWASocket = jest.fn(() => mockSock);
const mockUseMultiFileAuthState = jest.fn(async () => ({
  state: { creds: { registered: mockRegistered } },
  saveCreds: mockSaveCreds,
}));
const mockDownloadMediaMessage = jest.fn(async () => Buffer.from('fake-jpeg-bytes'));

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockMakeWASocket(...(args as [])),
  useMultiFileAuthState: (...args: unknown[]) => mockUseMultiFileAuthState(...(args as [])),
  DisconnectReason: { loggedOut: 401, connectionClosed: 428 },
  Browsers: { ubuntu: (name: string) => ['Ubuntu', name, '1.0'] },
  downloadMediaMessage: (...args: unknown[]) => mockDownloadMediaMessage(...(args as [])),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { WhatsAppManager } from '../../src/whatsapp/manager';

/** Find the listener registered for `event` via mockSock.ev.on(event, listener). */
function listenerFor(event: string): (payload: unknown) => void {
  const call = mockSock.ev.on.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no listener registered for ${event}`);
  return call[1] as (payload: unknown) => void;
}

/**
 * Poll `check()` until it returns truthy or `timeoutMs` elapses. Connection-
 * update handling is a fire-and-forget async chain (`void
 * this.handleConnectionUpdate(update)`), so a fixed delay is inherently
 * racy under Jest's worker-pool scheduling — polling is the only reliable
 * way to wait for it without over- or under-shooting.
 */
async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'getpod',
    description: 'test',
    workspace,
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('WhatsAppManager', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let manager: InstanceType<typeof WhatsAppManager>;
  const realFetch = global.fetch;
  let fetchCalls: { url: string; body: unknown }[];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-whatsapp-mgr-'));
    agentConfig = makeAgentConfig(tmpDir);
    mockRegistered = false;
    mockSock.ev.on.mockClear();
    mockSock.sendMessage.mockClear();
    mockSock.requestPairingCode.mockClear();
    mockSock.logout.mockClear();
    mockMakeWASocket.mockClear();
    mockUseMultiFileAuthState.mockClear();
    mockSaveCreds.mockClear();
    fetchCalls = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: true } as Response;
    }) as typeof fetch;
    manager = new WhatsAppManager(agentConfig, 'default', 12345, tmpDir);
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts unlinked with no status extras', () => {
    expect(manager.getStatus()).toEqual({ status: 'unlinked', qr: undefined, pairingCode: undefined, phoneNumber: undefined, loggedOut: false });
  });

  it('resumeIfLinked() no-ops when no creds.json exists on disk', async () => {
    await manager.resumeIfLinked();
    expect(mockMakeWASocket).not.toHaveBeenCalled();
    expect(manager.getStatus().status).toBe('unlinked');
  });

  it('resumeIfLinked() connects when a prior session exists on disk', async () => {
    const stateDir = path.join(tmpDir, '.whatsapp-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'creds.json'), '{}');
    await manager.resumeIfLinked();
    expect(mockMakeWASocket).toHaveBeenCalledTimes(1);
  });

  it('startLinking() opens a socket and QR event renders a data URI', async () => {
    await manager.startLinking();
    expect(mockMakeWASocket).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().status).toBe('pending_scan');

    const onConnectionUpdate = listenerFor('connection.update');
    onConnectionUpdate({ qr: 'RAW_QR_STRING' });
    // QR rendering (QRCode.toDataURL) is fired-and-forgotten from the
    // connection.update listener — poll rather than guess a fixed delay.
    await waitUntil(() => !!manager.getStatus().qr);
    expect(manager.getStatus().qr).toMatch(/^data:image\/png;base64,/);
  });

  it('requestPairingCode() requests a code and does not set a QR', async () => {
    const code = await manager.requestPairingCode('+15551234567');
    expect(code).toBe('ABCD-1234');
    expect(mockSock.requestPairingCode).toHaveBeenCalledWith('+15551234567');
    expect(manager.getStatus().pairingCode).toBe('ABCD-1234');
    expect(manager.getStatus().qr).toBeUndefined();
  });

  it('requestPairingCode() waits for ws.isOpen before sending the request', async () => {
    // Baileys' real socket opens its WebSocket asynchronously — requestPairingCode
    // must not fire until ws.isOpen flips true, or it hits "Connection Closed" on
    // a not-yet-open socket (the bug this wait fixes).
    (mockSock as { ws: { isOpen: boolean } }).ws.isOpen = false;
    const pending = manager.requestPairingCode('+15551234567');
    // Give the poll loop a couple of ticks to run — it must NOT have called
    // requestPairingCode yet while the socket is still closed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockSock.requestPairingCode).not.toHaveBeenCalled();
    (mockSock as { ws: { isOpen: boolean } }).ws.isOpen = true;
    const code = await pending;
    expect(code).toBe('ABCD-1234');
    expect(mockSock.requestPairingCode).toHaveBeenCalledWith('+15551234567');
  });

  it('waitForSocketOpen() throws a clear error if the socket never opens (short timeout, not the full 10s default)', async () => {
    (mockSock as { ws: { isOpen: boolean } }).ws.isOpen = false;
    const waitForSocketOpen = (
      manager as unknown as { waitForSocketOpen: (sock: unknown, timeoutMs?: number) => Promise<void> }
    ).waitForSocketOpen.bind(manager);
    await expect(waitForSocketOpen(mockSock, 300)).rejects.toThrow(
      'WhatsApp socket did not open in time for the pairing-code request',
    );
    (mockSock as { ws: { isOpen: boolean } }).ws.isOpen = true;
  });

  it('connection open → linked, captures the phone number from sock.user.id', async () => {
    await manager.startLinking();
    listenerFor('connection.update')({ connection: 'open' });
    const status = manager.getStatus();
    expect(status.status).toBe('linked');
    expect(status.phoneNumber).toBe('66899990000');
    expect(status.qr).toBeUndefined();
  });

  it('creds.update persists via saveCreds on every fire', async () => {
    await manager.startLinking();
    const onCredsUpdate = listenerFor('creds.update');
    onCredsUpdate({ some: 'partial-creds' });
    expect(mockSaveCreds).toHaveBeenCalled();
  });

  describe('disconnect handling', () => {
    it("loggedOut → unlinked, no reconnect, wipes the 'default' account's creds", async () => {
      // The 'default' account shares the BARE .whatsapp-state/ dir with the
      // channel's message-turn state and with every other account's
      // subdirectory (see src/config/whatsapp-accounts.ts), so its wipe clears
      // the credential FILES rather than removing the directory.
      const stateDir = path.join(tmpDir, '.whatsapp-state');
      const siblingDir = path.join(stateDir, 'work');
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'creds.json'), '{}');
      fs.writeFileSync(path.join(siblingDir, 'creds.json'), '{}');

      await manager.startLinking();
      const onConnectionUpdate = listenerFor('connection.update');
      onConnectionUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      // The wipe is a real fs promise fired from the same fire-and-forget
      // handler — poll rather than guess a fixed delay.
      await waitUntil(() => !fs.existsSync(path.join(stateDir, 'creds.json')));

      const status = manager.getStatus();
      expect(status.status).toBe('unlinked');
      expect(status.loggedOut).toBe(true);
      // A second linked number must survive this account being logged out.
      expect(fs.existsSync(path.join(siblingDir, 'creds.json'))).toBe(true);
    });

    it("loggedOut on a NON-default account removes only that account's directory", async () => {
      const work = new WhatsAppManager(agentConfig, 'work', 12345, tmpDir);
      const stateDir = path.join(tmpDir, '.whatsapp-state');
      const workDir = path.join(stateDir, 'work');
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'creds.json'), '{}');
      fs.writeFileSync(path.join(workDir, 'creds.json'), '{}');

      await work.startLinking();
      listenerFor('connection.update')({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      await waitUntil(() => !fs.existsSync(workDir));

      // 'default' is untouched: nested accounts get a whole-directory remove.
      expect(fs.existsSync(path.join(stateDir, 'creds.json'))).toBe(true);
    });

    it('a non-loggedOut close → reconnecting, does NOT wipe state', async () => {
      const stateDir = path.join(tmpDir, '.whatsapp-state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'creds.json'), '{}');

      await manager.startLinking();
      listenerFor('connection.update')({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });

      expect(manager.getStatus().status).toBe('reconnecting');
      expect(manager.getStatus().loggedOut).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
      manager.stop(); // avoid a real setTimeout reconnect firing after the test ends
    });
  });

  describe('inbound messages.upsert', () => {
    async function open() {
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
    }

    it('bot-loop protection: fromMe messages are ignored', async () => {
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net', fromMe: true }, message: { conversation: 'echo' } }],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(0);
    });

    it('history-sync backfill (type !== notify) is ignored', async () => {
      await open();
      listenerFor('messages.upsert')({
        type: 'append',
        messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net' }, message: { conversation: 'old' } }],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(0);
    });

    it('an allowed DM (open dmPolicy) forwards content+meta to the callback port', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
            message: { conversation: 'hello' },
          },
        ],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('http://127.0.0.1:12345/channel');
      expect(fetchCalls[0].body).toMatchObject({
        content: 'hello',
        meta: { source: 'whatsapp', chat_id: '66811110000@s.whatsapp.net', whatsapp_chat_type: 'user', account_id: 'default' },
      });
    });

    it('a denied DM (closed default) is NOT forwarded, and mints a pending pairing code', async () => {
      await open(); // no whatsapp config at all → closed default
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { conversation: 'hi' } }],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(0);
      const pending = getPendingSenders('whatsapp', 'getpod');
      expect(pending).toHaveLength(1);
      expect(pending[0].userId).toBe('66811110000@s.whatsapp.net');
      expect(pending[0].code).toBeTruthy();
      expect(mockSock.sendMessage).toHaveBeenCalledWith('66811110000@s.whatsapp.net', expect.objectContaining({ text: expect.stringContaining(pending[0].code!) }));
    });

    it('pairing:false suppresses the pairing-code auto-reply, still records the pending sender', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', pairing: false }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { conversation: 'hi' } }],
      });
      await new Promise((r) => setImmediate(r));
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
      expect(getPendingSenders('whatsapp', 'getpod')).toHaveLength(1);
    });

    it('a group message requires @mention by default even under groupPolicy open', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', groupPolicy: 'open' }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '123-456@g.us', participant: '66811110000@s.whatsapp.net', id: 'MSG1' },
            message: { conversation: 'no mention here' },
          },
        ],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(0);
    });

    it('a group message WITH @mention of the bot forwards to the callback', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', groupPolicy: 'open' }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '123-456@g.us', participant: '66811110000@s.whatsapp.net', id: 'MSG1' },
            message: {
              extendedTextMessage: {
                text: '@bot hello',
                contextInfo: { mentionedJid: [mockSock.user.id] },
              },
            },
          },
        ],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toMatchObject({ meta: { whatsapp_chat_type: 'group' } });
    });

    it('requireMention:false answers every allowed group message, mentioned or not', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', groupPolicy: 'open', requireMention: false }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '123-456@g.us', participant: '66811110000@s.whatsapp.net', id: 'MSG1' },
            message: { conversation: 'no mention needed' },
          },
        ],
      });
      await new Promise((r) => setImmediate(r));
      expect(fetchCalls).toHaveLength(1);
    });

    it('an inbound image is downloaded, sniffed, and set as meta.image_path', async () => {
      agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
      await open();
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
            message: { imageMessage: {} },
          },
        ],
      });
      await new Promise((r) => setImmediate(r));
      expect(mockDownloadMediaMessage).toHaveBeenCalled();
      expect(fetchCalls[0].body).toMatchObject({ meta: expect.objectContaining({ image_path: expect.stringContaining('whatsapp-img-') }) });
    });
  });

  describe('sendMessage()', () => {
    it('throws when not linked', async () => {
      await expect(manager.sendMessage('66811110000@s.whatsapp.net', 'hi')).rejects.toThrow('not linked');
    });

    it('sends plain text once linked', async () => {
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      await manager.sendMessage('66811110000@s.whatsapp.net', 'hi');
      expect(mockSock.sendMessage).toHaveBeenCalledWith('66811110000@s.whatsapp.net', { text: 'hi' });
    });

    it('sends an image with caption when imagePath is given', async () => {
      const imgPath = path.join(tmpDir, 'out.jpg');
      fs.writeFileSync(imgPath, Buffer.from('x'));
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      await manager.sendMessage('66811110000@s.whatsapp.net', 'caption', imgPath);
      expect(mockSock.sendMessage).toHaveBeenCalledWith('66811110000@s.whatsapp.net', {
        image: { url: imgPath },
        caption: 'caption',
      });
    });

    it('rejects a missing image file', async () => {
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      await expect(
        manager.sendMessage('66811110000@s.whatsapp.net', '', path.join(tmpDir, 'nope.jpg')),
      ).rejects.toThrow('not found');
    });
  });

  describe('unlink()', () => {
    it("logs out, resets status, and wipes the 'default' account's creds", async () => {
      const stateDir = path.join(tmpDir, '.whatsapp-state');
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      expect(fs.existsSync(stateDir)).toBe(true);
      fs.writeFileSync(path.join(stateDir, 'creds.json'), '{}');

      await manager.unlink();
      expect(mockSock.logout).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().status).toBe('unlinked');
      // Files gone, directory kept — it is shared (see the loggedOut test).
      expect(fs.existsSync(path.join(stateDir, 'creds.json'))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
    });

    it('a non-default account gets its own nested state directory', async () => {
      const work = new WhatsAppManager(agentConfig, 'work', 12345, tmpDir);
      await work.startLinking();
      expect(mockUseMultiFileAuthState).toHaveBeenLastCalledWith(
        path.join(tmpDir, '.whatsapp-state', 'work'),
      );
      await work.unlink();
      expect(fs.existsSync(path.join(tmpDir, '.whatsapp-state', 'work'))).toBe(false);
    });
  });
});
