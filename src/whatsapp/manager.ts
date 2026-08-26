/**
 * WhatsAppManager — per-agent WhatsApp Web bridge via Baileys, run IN-PROCESS
 * in the main gateway (not a spawned child, unlike Telegram/Discord's
 * receivers). See the design note in AgentConfig.whatsapp's doc comment
 * (src/types.ts) and the plan this was built from for why: Baileys
 * multiplexes ALL send/receive through one live multi-device WebSocket tied
 * to the linked session — there is no stateless per-call REST path the way
 * Discord/Telegram/Slack/SMS have, so the socket must be a long-lived
 * resource the gateway process holds and reaches into directly (via
 * src/api/router.ts's internal /whatsapp/send route), not something an MCP
 * subprocess can independently reconnect for every reply.
 *
 * One WhatsAppManager per agent, created once by AgentRunner and kept for
 * the runner's lifetime (unlike SlackClient/DiscordReceiver, which are
 * torn down and rebuilt on every config change — there is no "config
 * change" for WhatsApp to react to, since the credential IS the on-disk
 * session, not a config.json field).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// Baileys ships as pure ESM ("type": "module") — a static top-level import
// makes ts-jest/CommonJS test runs throw "Cannot use import statement
// outside a module" the instant ANYTHING transitively imports this file
// (which is nearly every test, via agent/runner.ts), even tests that never
// touch WhatsApp at all. Load it lazily via dynamic import() instead —
// Node's native ESM interop handles that fine from a CommonJS module, and
// it means an agent that never uses WhatsApp never pays Baileys' module-load
// cost either. Type-only imports below are erased at compile time (no
// runtime require), so they're safe to keep static.
import type {
  default as makeWASocketType,
  useMultiFileAuthState as useMultiFileAuthStateType,
  DisconnectReason as DisconnectReasonType,
  Browsers as BrowsersType,
  downloadMediaMessage as downloadMediaMessageType,
  WASocket,
  WAMessage,
} from '@whiskeysockets/baileys';
type BaileysModule = {
  default: typeof makeWASocketType;
  useMultiFileAuthState: typeof useMultiFileAuthStateType;
  DisconnectReason: typeof DisconnectReasonType;
  Browsers: typeof BrowsersType;
  downloadMediaMessage: typeof downloadMediaMessageType;
};
async function loadBaileys(): Promise<BaileysModule> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  return (await import('@whiskeysockets/baileys')) as unknown as BaileysModule;
}
import type { Boom } from '@hapi/boom';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { AgentConfig } from '../types';
import { createLogger } from '../logger';
import { MediaStore } from '../history/media-store';
import { sniffImageExt } from '../shared/image-sniff';
import {
  isResolvedSourceAllowed,
  resolveWhatsAppSource,
  wasBotMentioned,
  type WhatsAppMessageLike,
} from '../api/whatsapp-access';
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSender,
  generatePairingCode,
} from '../api/pending-senders';

const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;
const SLOW_RESTART_DELAY_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = MediaStore.maxUploadBytes;

export type WhatsAppLinkStatus = 'unlinked' | 'pending_scan' | 'linked' | 'reconnecting';

export interface WhatsAppStatus {
  status: WhatsAppLinkStatus;
  /** Base64 PNG data URI, present only while status === 'pending_scan' and QR (not pairing-code) was requested. */
  qr?: string;
  /** Present only while status === 'pending_scan' and a pairing code was requested instead of QR. */
  pairingCode?: string;
  /** The linked WhatsApp number (E.164-ish, no '+'), present only once status === 'linked'. */
  phoneNumber?: string;
  /** True once a `loggedOut` disconnect was seen — no auto-reconnect happens; a fresh link is required. */
  loggedOut?: boolean;
}

/**
 * One-time pairing-code message — same visual-match-code contract as every
 * other channel's pairing flow (the sender reports the code to the admin,
 * who matches it in the UI before adding them to the allowlist).
 */
function pairingMessage(code: string, isGroup: boolean): string {
  const thWhere = isGroup ? 'ในกลุ่มนี้' : '';
  const enWhere = isGroup ? ' in this group' : '';
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท${thWhere} (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access${enWhere}. (No need to reply with it.)`
  );
}

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private status: WhatsAppLinkStatus = 'unlinked';
  private qrDataUri: string | undefined;
  private pairingCode: string | undefined;
  private phoneNumber: string | undefined;
  private loggedOut = false;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateDir: string;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly pinoLogger = pino({ level: 'silent' });
  private baileys: BaileysModule | null = null;

  constructor(
    private agentConfig: AgentConfig,
    private readonly callbackPort: number,
    private readonly logDir: string,
  ) {
    this.stateDir = path.join(agentConfig.workspace, '.whatsapp-state');
    this.logger = createLogger(`${agentConfig.id}:whatsapp`, logDir);
  }

  updateAgentConfig(newConfig: AgentConfig): void {
    this.agentConfig = newConfig;
    // No credential to react to (see class doc comment) — access-control
    // fields (dmPolicy etc.) are read live off this.agentConfig on every
    // inbound message, so nothing else needs to happen here.
  }

  getStatus(): WhatsAppStatus {
    return {
      status: this.status,
      qr: this.qrDataUri,
      pairingCode: this.pairingCode,
      phoneNumber: this.phoneNumber,
      loggedOut: this.loggedOut,
    };
  }

  /** Resume a previously-linked session on gateway boot — no-op if never linked. */
  async resumeIfLinked(): Promise<void> {
    if (!fs.existsSync(path.join(this.stateDir, 'creds.json'))) return;
    this.logger.info('Resuming previously-linked WhatsApp session', { agentId: this.agentConfig.id });
    await this.connect();
  }

  /** Start a fresh QR-code linking flow. */
  async startLinking(): Promise<void> {
    this.pairingCode = undefined;
    await this.connect();
  }

  /**
   * Request a pairing code instead of QR. Per Baileys' contract this must be
   * called once the socket is up but before it's registered — connect()
   * always opens the socket first; if the caller wants a pairing code, pass
   * the phone number and it's requested right after the socket is ready.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.qrDataUri = undefined;
    await this.connect(phoneNumber);
    if (!this.pairingCode) throw new Error('Failed to obtain a pairing code');
    return this.pairingCode;
  }

  private async connect(pairingPhoneNumber?: string): Promise<void> {
    this.stopping = false;
    const baileys = this.baileys ?? (this.baileys = await loadBaileys());
    fs.mkdirSync(this.stateDir, { recursive: true });
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.stateDir);

    const sock = baileys.default({
      auth: state,
      browser: baileys.Browsers.ubuntu('GetPod'),
      logger: this.pinoLogger,
    });
    this.sock = sock;
    this.status = this.status === 'linked' ? 'reconnecting' : 'pending_scan';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update);
    });

    sock.ev.on('messages.upsert', (payload) => {
      void this.handleMessagesUpsert(payload);
    });

    if (pairingPhoneNumber && !state.creds.registered) {
      try {
        // sock.ws only finishes its handshake asynchronously after
        // baileys.default() returns — requestPairingCode sends over that raw
        // socket immediately, so calling it before ws.isOpen throws
        // "Connection Closed" nearly every time (the comment above used to
        // assume "the socket is up" meant "the connection is open"; it
        // doesn't — those are two different moments).
        await this.waitForSocketOpen(sock);
        this.pairingCode = await sock.requestPairingCode(pairingPhoneNumber);
      } catch (err) {
        this.logger.error('requestPairingCode failed', { error: (err as Error).message });
        throw err;
      }
    }
  }

  /**
   * Poll `sock.ws.isOpen` until the underlying WebSocket handshake completes
   * (or `timeoutMs` elapses). There's no Baileys-emitted event for "ws is
   * open but not yet authenticated" to await instead — `connection.update`
   * only fires once the higher-level handshake is further along, which is
   * later than requestPairingCode needs.
   */
  private async waitForSocketOpen(sock: WASocket, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!sock.ws?.isOpen) {
      if (this.stopping) throw new Error('WhatsApp connection stopped before it opened');
      if (Date.now() - start > timeoutMs) {
        throw new Error('WhatsApp socket did not open in time for the pairing-code request');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): Promise<void> {
    if (update.qr && !this.pairingCode) {
      try {
        this.qrDataUri = await QRCode.toDataURL(update.qr);
      } catch (err) {
        this.logger.error('Failed to render QR', { error: (err as Error).message });
      }
    }

    if (update.connection === 'open') {
      this.status = 'linked';
      this.qrDataUri = undefined;
      this.pairingCode = undefined;
      this.loggedOut = false;
      this.restartCount = 0;
      this.phoneNumber = this.sock?.user?.id?.split(':')[0]?.split('@')[0];
      this.logger.info('WhatsApp linked', { agentId: this.agentConfig.id, phoneNumber: this.phoneNumber });
    }

    if (update.connection === 'close') {
      const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      this.sock = null;
      if (statusCode === this.baileys!.DisconnectReason.loggedOut) {
        this.loggedOut = true;
        this.status = 'unlinked';
        this.logger.warn('WhatsApp session logged out — re-linking required', {
          agentId: this.agentConfig.id,
        });
        // The old session is dead; wipe it so a fresh link doesn't try to
        // resume invalid creds.
        await fsp.rm(this.stateDir, { recursive: true, force: true }).catch(() => {});
        return;
      }
      this.status = 'reconnecting';
      if (!this.stopping) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const slowPhase = this.restartCount >= MAX_RESTARTS;
    const delay = slowPhase ? SLOW_RESTART_DELAY_MS : AUTO_RESTART_DELAY_MS;
    if (!slowPhase) this.restartCount++;
    this.logger.warn(`Reconnecting WhatsApp in ${delay}ms`, {
      agentId: this.agentConfig.id,
      attempt: this.restartCount,
      slowPhase,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) void this.connect();
    }, delay);
  }

  private async handleMessagesUpsert(payload: { messages: WAMessage[]; type: string }): Promise<void> {
    // Only live/new messages, not history-sync backfill on (re)connect.
    if (payload.type !== 'notify') return;

    for (const msg of payload.messages) {
      if (msg.key?.fromMe) continue; // bot-loop protection
      const resolved = resolveWhatsAppSource(msg as WhatsAppMessageLike);
      if (resolved.kind === 'other' || !resolved.conversationId) continue;

      const cfg = this.agentConfig.whatsapp;
      const deniedAgentId = this.agentConfig.id;

      if (!isResolvedSourceAllowed(cfg, resolved)) {
        this.logger.debug('WhatsApp message denied', {
          agentId: deniedAgentId,
          kind: resolved.kind,
          conversationId: resolved.conversationId,
        });
        const knockId = resolved.kind === 'user' ? resolved.senderId : resolved.conversationId;
        const isGroup = resolved.kind === 'group';
        const sourcePolicy = isGroup ? cfg?.groupPolicy : cfg?.dmPolicy;
        const isPairing = cfg?.pairing !== false && sourcePolicy !== 'open' && sourcePolicy !== 'disabled';
        const prev = getPendingSender('whatsapp', deniedAgentId, knockId);
        const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);
        const wasNew = isGroup
          ? recordDeniedConversation('whatsapp', deniedAgentId, knockId, 'group', undefined, Date.now(), code)
          : recordDeniedSender('whatsapp', deniedAgentId, knockId, undefined, Date.now(), code);

        if (isPairing && wasNew && code) {
          void this.sock?.sendMessage(resolved.conversationId, { text: pairingMessage(code, isGroup) })
            .catch((err: unknown) =>
              this.logger.debug('WhatsApp pairing code send failed', { error: (err as Error).message }),
            );
        }
        continue;
      }

      // Group mention gate — mirrors Slack/LINE's requireMention (default true, no effect on DMs).
      if (resolved.kind === 'group' && cfg?.requireMention !== false) {
        const botJid = this.sock?.user?.id;
        // `sock.user.lid` is the bot's own @lid identity under WhatsApp's Linked
        // ID privacy system — groups can report the mention using either form.
        const botLid = this.sock?.user?.lid;
        if (!wasBotMentioned(resolved.mentionedJids, botJid, botLid)) continue;
      }

      const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
      const meta: Record<string, string> = {
        source: 'whatsapp',
        chat_id: resolved.conversationId,
        user_id: resolved.senderId,
        user: resolved.senderId,
        message_id: msg.key?.id ?? '',
        whatsapp_chat_type: resolved.kind,
      };

      // Inbound image — best-effort, same posture as Slack's downloadSlackImage:
      // a failed download still forwards the text turn.
      if (msg.message?.imageMessage) {
        try {
          const buf = (await this.baileys!.downloadMediaMessage(msg, 'buffer', {})) as Buffer;
          if (buf.length > 0 && buf.length <= MAX_IMAGE_BYTES) {
            const dest = path.join(
              os.tmpdir(),
              `whatsapp-img-${msg.key?.id ?? Date.now()}.${sniffImageExt(buf)}`,
            );
            fs.writeFileSync(dest, buf);
            meta.image_path = dest;
          } else if (buf.length > MAX_IMAGE_BYTES) {
            this.logger.warn('Inbound WhatsApp image exceeds cap, dropping media', {
              agentId: deniedAgentId,
              bytes: buf.length,
            });
          }
        } catch (err) {
          this.logger.warn('Inbound WhatsApp image download failed', {
            agentId: deniedAgentId,
            error: (err as Error).message,
          });
        }
      }

      try {
        await fetch(`http://127.0.0.1:${this.callbackPort}/channel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, meta }),
        });
      } catch (err) {
        this.logger.error('WhatsApp: failed to forward to callback', {
          agentId: deniedAgentId,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Send a text (+ optional image) reply on the live socket. Throws if not currently linked. */
  async sendMessage(jid: string, text: string, imagePath?: string): Promise<void> {
    if (!this.sock || this.status !== 'linked') {
      throw new Error('WhatsApp is not linked');
    }
    if (imagePath) {
      const stat = await fsp.stat(imagePath).catch(() => null);
      if (!stat) throw new Error(`image not found: ${imagePath}`);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
      }
      await this.sock.sendMessage(jid, { image: { url: imagePath }, caption: text || undefined });
      return;
    }
    await this.sock.sendMessage(jid, { text });
  }

  isLinked(): boolean {
    return this.status === 'linked';
  }

  /** Logout and wipe the linked session — the user must scan/pair fresh afterward. */
  async unlink(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      await this.sock?.logout();
    } catch {
      // best-effort — proceed to wipe state regardless
    }
    this.sock = null;
    this.status = 'unlinked';
    this.qrDataUri = undefined;
    this.pairingCode = undefined;
    this.phoneNumber = undefined;
    this.loggedOut = false;
    await fsp.rm(this.stateDir, { recursive: true, force: true }).catch(() => {});
  }

  /** Tear down without wiping state (gateway shutdown — a reconnect on next boot should resume). */
  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.sock?.end(undefined);
    this.sock = null;
  }
}
