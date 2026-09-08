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
  // Phase 2: read receipts and outbound native @mentions.
  readMessages: jest.fn(async () => undefined),
  groupMetadata: jest.fn(async () => ({ participants: [] as unknown[] })),
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

/**
 * Outbound image auto-optimize. Mocked at the module boundary so these tests
 * assert the WIRING (is it called, with what cap, is its result the path that
 * actually gets sent, is it skipped for a document) — the shrinking itself is
 * covered by tests/unit/image-optimize*.test.ts. Default passthrough: returns
 * the path it was given, i.e. "nothing could be gained".
 */
const mockOptimizeImageFile = jest.fn(async (p: string, _maxBytes: number) => p);
jest.mock('../../src/shared/image-optimize', () => ({
  optimizeImageFile: (...args: unknown[]) => mockOptimizeImageFile(...(args as [string, number])),
  optimizeImage: jest.fn(async (b: Buffer) => b),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { WhatsAppManager } from '../../src/whatsapp/manager';
import { MediaStore } from '../../src/history/media-store';

/** Find the listener registered for `event` via mockSock.ev.on(event, listener). */
function listenerFor(event: string): (payload: unknown) => void {
  const call = mockSock.ev.on.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no listener registered for ${event}`);
  return call[1] as (payload: unknown) => void;
}

/**
 * mockSock.sendMessage is declared with no parameters (jest infers a `[]`
 * tuple), so reading back what it was CALLED with needs a loose view of the
 * argument list. `toHaveBeenCalledWith` doesn't — only inspection does.
 */
function sendCalls(): unknown[][] {
  return mockSock.sendMessage.mock.calls as unknown as unknown[][];
}

/** The reaction payloads among those sends (ack add / ack clear). */
function reactionSends(): Array<{ text: string; key: { id?: string } }> {
  return sendCalls()
    .map((c) => (c[1] as { react?: { text: string; key: { id?: string } } } | undefined)?.react)
    .filter((r): r is { text: string; key: { id?: string } } => !!r);
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
    mockSock.readMessages.mockClear();
    mockSock.groupMetadata.mockClear();
    mockSock.groupMetadata.mockImplementation(async () => ({ participants: [] as unknown[] }));
    mockMakeWASocket.mockClear();
    mockUseMultiFileAuthState.mockClear();
    mockSaveCreds.mockClear();
    mockOptimizeImageFile.mockClear();
    mockOptimizeImageFile.mockImplementation(async (p: string) => p);
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
      const pending = getPendingSenders('whatsapp:default', 'getpod');
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
      expect(getPendingSenders('whatsapp:default', 'getpod')).toHaveLength(1);
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

    // ---- Phase 2 ---------------------------------------------------------

    describe('reply context', () => {
      /** Baileys inlines the whole quoted message, unlike Meta's Cloud webhook. */
      function quoteUpsert(contextInfo: Record<string, unknown>) {
        return {
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG2' },
              message: { extendedTextMessage: { text: 'yes, that one', contextInfo } },
            },
          ],
        };
      }

      it('populates ALL THREE replied_* keys from contextInfo', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')(
          quoteUpsert({
            stanzaId: 'MSG1',
            participant: '66811110000@s.whatsapp.net',
            quotedMessage: { conversation: 'the original question' },
          }),
        );
        await new Promise((r) => setImmediate(r));
        expect(fetchCalls[0].body).toMatchObject({
          meta: {
            replied_message_id: 'MSG1',
            replied_user: '66811110000@s.whatsapp.net',
            replied_text: 'the original question',
          },
        });
      });

      it('falls back to a quoted image/video caption for replied_text', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')(
          quoteUpsert({
            stanzaId: 'MSG1',
            participant: '66811110000@s.whatsapp.net',
            quotedMessage: { imageMessage: { caption: 'the chart' } },
          }),
        );
        await new Promise((r) => setImmediate(r));
        expect((fetchCalls[0].body as { meta: Record<string, string> }).meta.replied_text).toBe('the chart');
      });

      it('an ordinary message carries no replied_* keys at all', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { conversation: 'hi' } }],
        });
        await new Promise((r) => setImmediate(r));
        const meta = (fetchCalls[0].body as { meta: Record<string, string> }).meta;
        expect(Object.keys(meta).filter((k) => k.startsWith('replied_'))).toEqual([]);
      });
    });

    describe('receipt signals', () => {
      const upsert = {
        type: 'notify',
        messages: [{ key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { conversation: 'hi' } }],
      };

      it('marks the message read and adds the ⏳ ack by default', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')(upsert);
        await waitUntil(() => mockSock.readMessages.mock.calls.length > 0);
        expect(mockSock.readMessages).toHaveBeenCalledWith([
          { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
        ]);
        await waitUntil(() =>
          reactionSends().length > 0,
        );
        expect(mockSock.sendMessage).toHaveBeenCalledWith('66811110000@s.whatsapp.net', {
          react: { text: '⏳', key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' } },
        });
      });

      it('sendReadReceipts:false suppresses the read receipt but keeps the ack', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open', sendReadReceipts: false }] };
        await open();
        listenerFor('messages.upsert')(upsert);
        await waitUntil(() =>
          reactionSends().length > 0,
        );
        expect(mockSock.readMessages).not.toHaveBeenCalled();
      });

      it("reactionLevel:'off' suppresses the ack but keeps the read receipt", async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open', reactionLevel: 'off' }] };
        await open();
        listenerFor('messages.upsert')(upsert);
        await waitUntil(() => mockSock.readMessages.mock.calls.length > 0);
        await new Promise((r) => setImmediate(r));
        expect(reactionSends().length > 0).toBe(false);
      });

      it('both are best-effort: a socket that rejects them still forwards the turn', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        mockSock.readMessages.mockRejectedValueOnce(new Error('socket busy') as never);
        mockSock.sendMessage.mockRejectedValueOnce(new Error('socket busy') as never);
        await open();
        listenerFor('messages.upsert')(upsert);
        await waitUntil(() => fetchCalls.length > 0);
        expect(fetchCalls[0].body).toMatchObject({ content: 'hi' });
      });

      it('a DENIED sender gets neither signal (the gate runs first)', async () => {
        await open(); // no config → closed default
        listenerFor('messages.upsert')(upsert);
        await new Promise((r) => setImmediate(r));
        expect(mockSock.readMessages).not.toHaveBeenCalled();
        expect(reactionSends().length > 0).toBe(false);
      });
    });

    describe('location / contact / sticker', () => {
      it('a location pin → location_lat/lng meta plus a summary as content', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
              message: {
                locationMessage: {
                  degreesLatitude: 13.7563,
                  degreesLongitude: 100.5018,
                  name: 'Grand Palace',
                  address: 'Phra Nakhon, Bangkok',
                },
              },
            },
          ],
        });
        await new Promise((r) => setImmediate(r));
        // Same key names the Cloud channel writes, so runner.ts needs no
        // per-channel attribute handling.
        expect(fetchCalls[0].body).toMatchObject({
          content: 'Grand Palace, Phra Nakhon, Bangkok',
          meta: { location_lat: '13.7563', location_lng: '100.5018' },
        });
      });

      it('a bare dropped pin → generic content, coordinates still in meta', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
              message: { locationMessage: { degreesLatitude: 1.5, degreesLongitude: -2.25 } },
            },
          ],
        });
        await new Promise((r) => setImmediate(r));
        expect(fetchCalls[0].body).toMatchObject({
          content: '[Location shared]',
          meta: { location_lat: '1.5', location_lng: '-2.25' },
        });
      });

      it('a contact card → the RAW vCard Baileys already provides, verbatim', async () => {
        const VCARD = 'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+66812345678\nEND:VCARD';
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
              message: { contactMessage: { displayName: 'Ada', vcard: VCARD } },
            },
          ],
        });
        await new Promise((r) => setImmediate(r));
        expect((fetchCalls[0].body as { meta: Record<string, string> }).meta.vcard).toBe(VCARD);
      });

      it('a multi-contact array → the first card that actually has a vCard', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' },
              message: {
                contactsArrayMessage: {
                  contacts: [{ displayName: 'no card' }, { vcard: 'BEGIN:VCARD\nFN:Second\nEND:VCARD' }],
                },
              },
            },
          ],
        });
        await new Promise((r) => setImmediate(r));
        expect((fetchCalls[0].body as { meta: Record<string, string> }).meta.vcard).toContain('FN:Second');
      });

      it('a sticker → downloaded onto meta.sticker_path, NEVER image_path', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            { key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { stickerMessage: {} } },
          ],
        });
        await new Promise((r) => setImmediate(r));
        expect(mockDownloadMediaMessage).toHaveBeenCalled();
        const meta = (fetchCalls[0].body as { meta: Record<string, string> }).meta;
        expect(meta.sticker_path).toContain('whatsapp-sticker-');
        expect(meta.image_path).toBeUndefined();
        fs.rmSync(meta.sticker_path, { force: true });
      });

      it('a failed sticker download still forwards the turn', async () => {
        agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
        mockDownloadMediaMessage.mockRejectedValueOnce(new Error('media gone') as never);
        await open();
        listenerFor('messages.upsert')({
          type: 'notify',
          messages: [
            { key: { remoteJid: '66811110000@s.whatsapp.net', id: 'MSG1' }, message: { stickerMessage: {} } },
          ],
        });
        await new Promise((r) => setImmediate(r));
        expect(fetchCalls).toHaveLength(1);
        expect((fetchCalls[0].body as { meta: Record<string, string> }).meta.sticker_path).toBeUndefined();
      });
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

    // ---- Phase 2 ---------------------------------------------------------

    const DM = '66811110000@s.whatsapp.net';
    const GROUP = '123-456@g.us';

    /** Link the socket and deliver one inbound message so it is quotable. */
    async function linkedWithInbound(id = 'MSG1', jid = DM): Promise<void> {
      agentConfig.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open', groupPolicy: 'open', requireMention: false }] };
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      listenerFor('messages.upsert')({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: jid, ...(jid.endsWith('@g.us') ? { participant: DM } : {}), id },
            message: { conversation: 'the original' },
          },
        ],
      });
      await waitUntil(() => fetchCalls.length > 0);
      mockSock.sendMessage.mockClear(); // drop the inbound ack reaction
    }

    it('splits a reply over the 4000-char cap into several sends', async () => {
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
      await manager.sendMessage(DM, long);

      const texts = sendCalls().map((c) => (c[1] as { text: string }).text);
      expect(texts.length).toBeGreaterThan(1);
      for (const t of texts) expect(t.length).toBeLessThanOrEqual(4000);
      expect(texts.join(' ')).toBe(long);
    });

    it('quotes the inbound message on the FIRST send only', async () => {
      await linkedWithInbound('MSG1');
      const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
      await manager.sendMessage(DM, long, undefined, { quotedMessageId: 'MSG1' });

      const calls = sendCalls().filter((c) => (c[1] as { text?: string }).text);
      expect(calls.length).toBeGreaterThan(1);
      expect((calls[0]![2] as { quoted?: { key?: { id?: string } } })?.quoted?.key?.id).toBe('MSG1');
      // Follow-up chunks get no third argument at all — repeating the quote
      // block on every bubble is visual noise.
      expect(calls[1]![2]).toBeUndefined();
    });

    it('an unknown quotedMessageId degrades to an ordinary unquoted send', async () => {
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      await manager.sendMessage(DM, 'hi', undefined, { quotedMessageId: 'NEVER-SEEN' });
      expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, { text: 'hi' });
    });

    it('asDocument sends the file as a document (exact pixels) instead of a photo', async () => {
      const imgPath = path.join(tmpDir, 'chart.png');
      fs.writeFileSync(imgPath, Buffer.from('x'));
      await manager.startLinking();
      listenerFor('connection.update')({ connection: 'open' });
      await manager.sendMessage(DM, 'the chart', imgPath, { asDocument: true });

      expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, {
        document: { url: imgPath },
        mimetype: 'image/png',
        fileName: 'chart.png',
        caption: 'the chart',
      });
    });

    /**
     * Outbound image auto-optimize. Before this, an over-cap photo threw and
     * the agent's whole reply vanished; now it is shrunk and sent. The cap
     * itself is unchanged (MediaStore's flat value) — only what happens on the
     * way past it.
     */
    describe('oversized outbound image auto-optimize', () => {
      const CAP = MediaStore.maxUploadBytes;

      /** Write a file that is genuinely over the cap, so the real stat drives the branch. */
      function writeOversized(name: string): string {
        const p = path.join(tmpDir, name);
        fs.writeFileSync(p, Buffer.alloc(CAP + 1024));
        return p;
      }

      async function linked(): Promise<void> {
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
      }

      it('shrinks an over-cap photo and sends the OPTIMIZED path instead of failing', async () => {
        const big = writeOversized('huge.png');
        const shrunk = path.join(tmpDir, 'huge-optimized.jpg');
        fs.writeFileSync(shrunk, Buffer.alloc(1024));
        mockOptimizeImageFile.mockImplementation(async () => shrunk);

        await linked();
        await expect(manager.sendMessage(DM, 'here', big)).resolves.toBeUndefined();

        expect(mockOptimizeImageFile).toHaveBeenCalledWith(big, CAP);
        expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, {
          image: { url: shrunk },
          caption: 'here',
        });
      });

      it('leaves an under-cap photo alone — optimize is never invoked', async () => {
        const small = path.join(tmpDir, 'small.png');
        fs.writeFileSync(small, Buffer.from('tiny'));

        await linked();
        await manager.sendMessage(DM, 'here', small);

        expect(mockOptimizeImageFile).not.toHaveBeenCalled();
        expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, {
          image: { url: small },
          caption: 'here',
        });
      });

      it('does NOT optimize an asDocument send — that mode exists to deliver exact bytes', async () => {
        const big = writeOversized('exact.png');
        await linked();

        await expect(manager.sendMessage(DM, 'chart', big, { asDocument: true })).rejects.toThrow(
          /exceeds .* byte cap/,
        );
        expect(mockOptimizeImageFile).not.toHaveBeenCalled();
      });

      it('still throws when optimization could not get the photo under the cap', async () => {
        const big = writeOversized('stubborn.png');
        // Best-effort by contract: optimizeImageFile hands back the source path
        // when nothing was gained.
        mockOptimizeImageFile.mockImplementation(async (p: string) => p);

        await linked();
        await expect(manager.sendMessage(DM, 'here', big)).rejects.toThrow(/exceeds .* byte cap/);
        expect(mockOptimizeImageFile).toHaveBeenCalledWith(big, CAP);
      });

      it('survives optimizeImageFile itself rejecting, falling back to the original', async () => {
        const big = writeOversized('boom.png');
        mockOptimizeImageFile.mockImplementation(async () => {
          throw new Error('sharp exploded');
        });

        await linked();
        // The optimize failure is swallowed; the pre-existing cap error is what
        // reaches the caller, never "sharp exploded".
        await expect(manager.sendMessage(DM, 'here', big)).rejects.toThrow(/exceeds .* byte cap/);
      });
    });

    it('clears the ⏳ ack once the reply lands (the MCP tool cannot do it itself)', async () => {
      await linkedWithInbound('MSG1');
      await manager.sendMessage(DM, 'answer', undefined, { ackMessageId: 'MSG1' });
      expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, {
        react: { text: '', key: { remoteJid: DM, id: 'MSG1' } },
      });
    });

    it("reactionLevel:'off' means nothing is cleared either (no ack was ever added)", async () => {
      await linkedWithInbound('MSG1');
      manager.updateAgentConfig({
        ...agentConfig,
        whatsapp: { accounts: [{ id: 'default', dmPolicy: 'open', reactionLevel: 'off' }] },
      });
      await manager.sendMessage(DM, 'answer', undefined, { ackMessageId: 'MSG1' });
      expect(reactionSends().length > 0).toBe(false);
    });

    describe('outbound native @mentions', () => {
      it('attaches the participant JIDs behind @<digits> tokens in a group', async () => {
        mockSock.groupMetadata.mockImplementation(async () => ({
          participants: [{ id: '66811110000@s.whatsapp.net' }, { id: '66822220000@s.whatsapp.net' }],
        }));
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
        await manager.sendMessage(GROUP, '@66811110000 please take a look');

        expect(mockSock.sendMessage).toHaveBeenCalledWith(GROUP, {
          text: '@66811110000 please take a look',
          mentions: ['66811110000@s.whatsapp.net'],
        });
      });

      it('matches a LID-privacy participant on its phoneNumber, sending the @lid id', async () => {
        // In a LID group the participant id is opaque while the human still
        // types the phone number — the same normalization the inbound mention
        // gate uses (whatsAppJidUser) has to bridge the two.
        mockSock.groupMetadata.mockImplementation(async () => ({
          participants: [{ id: '99887766@lid', phoneNumber: '66811110000:3@s.whatsapp.net' }],
        }));
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
        await manager.sendMessage(GROUP, 'ping @66811110000');
        expect(mockSock.sendMessage).toHaveBeenCalledWith(GROUP, {
          text: 'ping @66811110000',
          mentions: ['99887766@lid'],
        });
      });

      it('a DM is never given a mentions array, even with an @number in the text', async () => {
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
        await manager.sendMessage(DM, 'call @66811110000 later');
        expect(mockSock.groupMetadata).not.toHaveBeenCalled();
        expect(mockSock.sendMessage).toHaveBeenCalledWith(DM, { text: 'call @66811110000 later' });
      });

      it('an @number nobody in the group matches → plain text, no mentions', async () => {
        mockSock.groupMetadata.mockImplementation(async () => ({
          participants: [{ id: '66899998888@s.whatsapp.net' }],
        }));
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
        await manager.sendMessage(GROUP, 'hi @66811110000');
        expect(mockSock.sendMessage).toHaveBeenCalledWith(GROUP, { text: 'hi @66811110000' });
      });

      it('a failed groupMetadata lookup sends the reply anyway (best-effort)', async () => {
        mockSock.groupMetadata.mockRejectedValueOnce(new Error('not a participant') as never);
        await manager.startLinking();
        listenerFor('connection.update')({ connection: 'open' });
        await manager.sendMessage(GROUP, 'hi @66811110000');
        expect(mockSock.sendMessage).toHaveBeenCalledWith(GROUP, { text: 'hi @66811110000' });
      });
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
