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
 * One WhatsAppManager per LINKED ACCOUNT (Phase 1 of the WhatsApp
 * feature-parity plan made this multi-account; it used to be one per agent).
 * AgentRunner keeps a Map<accountId, WhatsAppManager> and only adds/removes
 * entries as `agentConfig.whatsapp.accounts` changes — an existing account's
 * live socket is never torn down just because a sibling account's config
 * moved, since the credential IS the on-disk session, not a config.json field.
 *
 * The account's id selects its session directory: 'default' keeps the
 * historical bare `<workspace>/.whatsapp-state/`, anything else nests under
 * it (see whatsAppStateDir in src/config/whatsapp-accounts.ts).
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
import { AgentConfig, WhatsAppAccountConfig } from '../types';
import {
  DEFAULT_WHATSAPP_ACCOUNT_ID,
  findWhatsAppAccount,
  whatsAppStateDir,
} from '../config/whatsapp-accounts';
import { createLogger } from '../logger';
import { MediaStore } from '../history/media-store';
import { sniffImageExt, sanitizeFilenameId } from '../shared/image-sniff';
import {
  isResolvedSourceAllowed,
  resolveWhatsAppSource,
  wasBotMentioned,
  whatsAppJidUser,
  type WhatsAppMessageLike,
} from '../api/whatsapp-access';
import { chunkText } from '../shared/text-chunk';
import { optimizeImageFile } from '../shared/image-optimize';
import { WHATSAPP_ACK_EMOJI } from '../shared/whatsapp-ack';
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

/**
 * Per-message character budget for outbound text (Phase 2). WhatsApp's own
 * ceiling is ~65k, but long single bubbles render badly and Baileys can be
 * flaky well below the protocol limit — 4000 is the conservative value the
 * Cloud channel's hard 4096 limit already forces us to design for, so both
 * WhatsApp channels behave the same way.
 */
const MAX_TEXT_CHARS = 4000;

/**
 * How many recent inbound messages to keep addressable. A quote-reply needs
 * the WHOLE original message (Baileys' `quoted` option takes a WAMessage, not
 * an id) and a reaction needs its full key (participant included, or a
 * reaction in a group lands on nothing), but the MCP tool only ever hands
 * back a message_id string. Bounded FIFO: this only has to outlive the gap
 * between an inbound message and the agent's reply to it.
 */
const RECENT_MESSAGE_CACHE_SIZE = 200;

/**
 * Extension-based mime guess for an outbound `forceDocument` send. These are
 * files the AGENT produced (a generated image, a rendered chart), not
 * attacker bytes, so the extension is trustworthy enough here — the inbound
 * side sniffs real magic bytes instead (sniffImageExt).
 */
function guessOutboundMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

/** Structural view of a Baileys quote context — only the fields used here. */
interface QuotedContext {
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: Record<string, unknown> | null;
}

/**
 * Pull the quote context off whichever message variant carries it. A plain
 * text message that quotes something is upgraded to `extendedTextMessage` by
 * WhatsApp, but a quoted IMAGE/sticker/document/video reply keeps its own
 * type and hangs `contextInfo` off that instead — so all of them are checked.
 */
function extractQuotedContext(message: Record<string, unknown> | null | undefined): QuotedContext | undefined {
  if (!message) return undefined;
  for (const key of [
    'extendedTextMessage',
    'imageMessage',
    'stickerMessage',
    'documentMessage',
    'videoMessage',
    'audioMessage',
  ]) {
    const ctx = (message[key] as { contextInfo?: QuotedContext } | undefined)?.contextInfo;
    if (ctx?.stanzaId) return ctx;
  }
  return undefined;
}

/** Best-effort body text of a quoted message, across the variants that have one. */
function quotedMessageText(quoted: Record<string, unknown> | null | undefined): string {
  if (!quoted) return '';
  const conversation = quoted.conversation;
  if (typeof conversation === 'string') return conversation;
  const extended = (quoted.extendedTextMessage as { text?: string | null } | undefined)?.text;
  if (typeof extended === 'string') return extended;
  for (const key of ['imageMessage', 'videoMessage', 'documentMessage']) {
    const caption = (quoted[key] as { caption?: string | null } | undefined)?.caption;
    if (typeof caption === 'string') return caption;
  }
  return '';
}

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
  /** Recent inbound messages by id — see RECENT_MESSAGE_CACHE_SIZE. */
  private readonly recentMessages = new Map<string, WAMessage>();

  constructor(
    private agentConfig: AgentConfig,
    /**
     * Which of the agent's WhatsApp accounts this instance owns. Selects the
     * on-disk session directory, tags every event forwarded to the runner,
     * and picks the access-control block read on each inbound message.
     */
    readonly accountId: string,
    private readonly callbackPort: number,
    private readonly logDir: string,
  ) {
    this.stateDir = whatsAppStateDir(agentConfig.workspace, accountId);
    this.logger = createLogger(
      accountId === DEFAULT_WHATSAPP_ACCOUNT_ID
        ? `${agentConfig.id}:whatsapp`
        : `${agentConfig.id}:whatsapp:${accountId}`,
      logDir,
    );
  }

  updateAgentConfig(newConfig: AgentConfig): void {
    this.agentConfig = newConfig;
    // No credential to react to (see class doc comment) — access-control
    // fields (dmPolicy etc.) are read live off this.accountConfig() on every
    // inbound message, so nothing else needs to happen here.
  }

  /**
   * This account's access-control block. Undefined when the account isn't in
   * config at all (an unconfigured agent's implicit 'default'), which the
   * gate treats exactly like an empty block — closed by default.
   */
  private accountConfig(): WhatsAppAccountConfig | undefined {
    return findWhatsAppAccount(this.agentConfig.whatsapp, this.accountId);
  }

  /**
   * Wipe this account's linked session.
   *
   * The 'default' account shares the bare `.whatsapp-state/` directory with
   * BOTH the channel's message-turn state and every other account's
   * subdirectory (see whatsAppStateDir), so a blind `rm -rf` of it would
   * unlink sibling accounts as collateral. Delete only the files at the top
   * level there — Baileys' `creds.json` and key files — and leave
   * subdirectories alone. Non-default accounts own their directory outright,
   * so those are removed wholesale.
   */
  private async wipeStateDir(): Promise<void> {
    if (this.accountId !== DEFAULT_WHATSAPP_ACCOUNT_ID) {
      await fsp.rm(this.stateDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const entries = await fsp.readdir(this.stateDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map((e) => fsp.rm(path.join(this.stateDir, e.name), { force: true }).catch(() => {})),
    );
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
    this.logger.info('Resuming previously-linked WhatsApp session', {
      agentId: this.agentConfig.id,
      accountId: this.accountId,
    });
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
    // 0o700: this directory holds creds.json — a live linked-session
    // credential equivalent to a password. Matches the 0o700 convention used
    // for every other secret-bearing directory in this codebase (see
    // config/bootstrap.ts, connectors/token-env.ts, session/process.ts).
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
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
        await this.wipeStateDir();
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

      const cfg = this.accountConfig();
      const deniedAgentId = this.agentConfig.id;

      if (!isResolvedSourceAllowed(cfg, resolved)) {
        this.logger.debug('WhatsApp message denied', {
          agentId: deniedAgentId,
          accountId: this.accountId,
          kind: resolved.kind,
          conversationId: resolved.conversationId,
        });
        const knockId = resolved.kind === 'user' ? resolved.senderId : resolved.conversationId;
        const isGroup = resolved.kind === 'group';
        const sourcePolicy = isGroup ? cfg?.groupPolicy : cfg?.dmPolicy;
        const isPairing = cfg?.pairing !== false && sourcePolicy !== 'open' && sourcePolicy !== 'disabled';
        // Namespaced per account, not just 'whatsapp' — the same JID can
        // legitimately knock on two different numbers linked to this agent,
        // and without the account dimension a knock on one number would
        // show up (and be approvable) against the other's allowlist too.
        const pendingChannel = `whatsapp:${this.accountId}`;
        const prev = getPendingSender(pendingChannel, deniedAgentId, knockId);
        const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);
        const wasNew = isGroup
          ? recordDeniedConversation(pendingChannel, deniedAgentId, knockId, 'group', undefined, Date.now(), code)
          : recordDeniedSender(pendingChannel, deniedAgentId, knockId, undefined, Date.now(), code);

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

      // Phase 2 — remember the raw message before anything else touches it: a
      // later quote-reply needs the whole WAMessage and a reaction needs its
      // full key, but the MCP tool only ever hands back the id string.
      if (msg.key?.id) this.rememberMessage(msg.key.id, msg);

      // Receipt signals, both best-effort and both config-gated. Fired right
      // after the access gate (same call site as Slack's ack reaction in
      // slack-webhook-router.ts), never awaited, never able to fail the turn.
      // The ack reaction is cleared once the reply actually sends — see
      // sendMessage's clearAckReaction call.
      if (msg.key) {
        if (cfg?.sendReadReceipts !== false) {
          void this.markAsRead(resolved.conversationId, msg.key).catch(() => {});
        }
        if ((cfg?.reactionLevel ?? 'ack') === 'ack') {
          void this.sendReaction(resolved.conversationId, msg.key, WHATSAPP_ACK_EMOJI).catch(() => {});
        }
      }

      let content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
      const meta: Record<string, string> = {
        source: 'whatsapp',
        chat_id: resolved.conversationId,
        user_id: resolved.senderId,
        user: resolved.senderId,
        message_id: msg.key?.id ?? '',
        whatsapp_chat_type: resolved.kind,
        // Which linked number this arrived on. Round-trips through the
        // <channel> tag (AgentRunner.buildChannelXml's optionalAttrs) so the
        // session can hand it straight back to whatsapp_reply, and is also
        // stashed runner-side per chat so an auto-forward reply without an
        // explicit account_id still leaves on the same number.
        account_id: this.accountId,
      };

      // Reply context (Phase 2). Unlike the Cloud API — which only reports the
      // quoted message's ID and nothing else — Baileys inlines the whole
      // quoted message, so all three `replied_*` keys buildChannelXml reads
      // can be populated here.
      const quotedCtx = extractQuotedContext(msg.message as Record<string, unknown> | null | undefined);
      if (quotedCtx?.stanzaId) {
        meta.replied_message_id = quotedCtx.stanzaId;
        if (quotedCtx.participant) meta.replied_user = quotedCtx.participant;
        const repliedText = quotedMessageText(quotedCtx.quotedMessage);
        if (repliedText) meta.replied_text = repliedText;
      }

      // Location — same meta keys the Cloud channel writes (location_lat /
      // location_lng), so runner.ts needs no channel-specific attribute names.
      const locationMsg = msg.message?.locationMessage;
      if (locationMsg) {
        if (typeof locationMsg.degreesLatitude === 'number') {
          meta.location_lat = String(locationMsg.degreesLatitude);
        }
        if (typeof locationMsg.degreesLongitude === 'number') {
          meta.location_lng = String(locationMsg.degreesLongitude);
        }
        if (!content) {
          content = [locationMsg.name, locationMsg.address].filter(Boolean).join(', ') || '[Location shared]';
        }
      }

      // Contact card. Baileys hands over the RAW vCard string the sender's
      // phone produced, so it's used verbatim — the Cloud channel has to
      // synthesize one instead (its payload is structured JSON, not a vCard).
      const vcard =
        msg.message?.contactMessage?.vcard ??
        msg.message?.contactsArrayMessage?.contacts?.find((c) => c.vcard)?.vcard;
      if (vcard) meta.vcard = vcard;

      // Sticker — downloaded like an image but onto its own meta key, so the
      // agent can tell a sticker apart from a photo.
      if (msg.message?.stickerMessage) {
        try {
          const buf = (await this.baileys!.downloadMediaMessage(msg, 'buffer', {})) as Buffer;
          if (buf.length > 0 && buf.length <= MAX_IMAGE_BYTES) {
            const dest = path.join(
              os.tmpdir(),
              `whatsapp-sticker-${sanitizeFilenameId(msg.key?.id)}.${sniffImageExt(buf)}`,
            );
            fs.writeFileSync(dest, buf, { mode: 0o600 });
            meta.sticker_path = dest;
          } else if (buf.length > MAX_IMAGE_BYTES) {
            this.logger.warn('Inbound WhatsApp sticker exceeds cap, dropping media', {
              agentId: deniedAgentId,
              bytes: buf.length,
            });
          }
        } catch (err) {
          this.logger.warn('Inbound WhatsApp sticker download failed', {
            agentId: deniedAgentId,
            error: (err as Error).message,
          });
        }
      }

      // Inbound image — best-effort, same posture as Slack's downloadSlackImage:
      // a failed download still forwards the text turn.
      if (msg.message?.imageMessage) {
        try {
          const buf = (await this.baileys!.downloadMediaMessage(msg, 'buffer', {})) as Buffer;
          if (buf.length > 0 && buf.length <= MAX_IMAGE_BYTES) {
            const dest = path.join(
              os.tmpdir(),
              `whatsapp-img-${sanitizeFilenameId(msg.key?.id)}.${sniffImageExt(buf)}`,
            );
            fs.writeFileSync(dest, buf, { mode: 0o600 });
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

  /** Keep the last RECENT_MESSAGE_CACHE_SIZE inbound messages addressable by id (FIFO). */
  private rememberMessage(id: string, msg: WAMessage): void {
    this.recentMessages.delete(id); // re-insert so this id becomes the newest
    this.recentMessages.set(id, msg);
    while (this.recentMessages.size > RECENT_MESSAGE_CACHE_SIZE) {
      const oldest = this.recentMessages.keys().next().value;
      if (oldest === undefined) break;
      this.recentMessages.delete(oldest);
    }
  }

  /**
   * Mark an inbound message as read (blue double-ticks). Best-effort: logged,
   * never thrown — same posture as the Cloud client's markAsRead and Slack's
   * ack reaction. `jid` is only used for log context; Baileys addresses the
   * read by key alone.
   */
  async markAsRead(jid: string, key: WAMessage['key']): Promise<void> {
    if (!this.sock || !key) return;
    try {
      await this.sock.readMessages([key]);
    } catch (err) {
      this.logger.debug('WhatsApp markAsRead failed', { jid, error: (err as Error).message });
    }
  }

  /**
   * React to a message — an EMPTY `emoji` clears an existing reaction, which
   * is how the ack is removed (same convention as the Cloud API). Best-effort,
   * same as markAsRead.
   */
  async sendReaction(jid: string, key: WAMessage['key'], emoji: string): Promise<void> {
    if (!this.sock || !key) return;
    try {
      await this.sock.sendMessage(jid, { react: { text: emoji, key } });
    } catch (err) {
      this.logger.debug('WhatsApp sendReaction failed', { jid, error: (err as Error).message });
    }
  }

  /**
   * Clear the ⏳ ack left on an inbound message at receipt.
   *
   * Unlike Slack (whose MCP tool holds a real API client and calls
   * `removeReaction` itself) the `whatsapp_reply` tool has no socket of its
   * own — every send is proxied through the gateway (see this class's doc
   * comment). So the tool passes the inbound `message_id` along with the
   * reply and the clear happens HERE, right after the send succeeds; the
   * call site is the same logical one, just on the other side of the bridge.
   */
  private async clearAckReaction(jid: string, messageId: string): Promise<void> {
    if ((this.accountConfig()?.reactionLevel ?? 'ack') !== 'ack') return;
    const key = this.recentMessages.get(messageId)?.key;
    if (!key) return;
    await this.sendReaction(jid, key, '');
  }

  /**
   * Native @mentions for an outbound GROUP reply.
   *
   * WhatsApp only renders "@66812345678" as a real, notifying mention when the
   * matching JID is also listed in the message's `mentions` array — the text
   * alone is inert. So: scan the reply for `@<digits>` tokens, look up the
   * group's CURRENT participants, and return the JIDs that match. Matching
   * reuses the same normalization the inbound mention gate uses
   * (`whatsAppJidUser`, which strips the `:<device>` suffix) rather than a
   * second, subtly-different comparison. Participants are also matched on
   * their phone-number field, since a LID-privacy group reports `id` as
   * `<opaque>@lid` while the human still types the phone number.
   *
   * Best-effort: a failed groupMetadata lookup just sends the reply without
   * mentions rather than failing it.
   */
  private async resolveMentions(jid: string, text: string): Promise<string[] | undefined> {
    if (!jid.endsWith('@g.us') || !text) return undefined;
    const wanted = new Set([...text.matchAll(/@(\d{5,})/g)].map((m) => m[1]!));
    if (wanted.size === 0) return undefined;
    try {
      const metadata = await this.sock?.groupMetadata(jid);
      const mentions: string[] = [];
      for (const participant of metadata?.participants ?? []) {
        const p = participant as { id?: string | null; jid?: string | null; phoneNumber?: string | null };
        if (!p.id) continue;
        const identities = [p.id, p.jid, p.phoneNumber].filter((v): v is string => !!v);
        if (identities.some((i) => wanted.has(whatsAppJidUser(i)))) mentions.push(p.id);
      }
      return mentions.length > 0 ? mentions : undefined;
    } catch (err) {
      this.logger.debug('WhatsApp groupMetadata lookup for mentions failed', {
        jid,
        error: (err as Error).message,
      });
      return undefined;
    }
  }

  /**
   * Send a text (+ optional image) reply on the live socket. Throws if not
   * currently linked.
   *
   * Text over MAX_TEXT_CHARS is split into several messages (Phase 2); with
   * an image attached the first chunk rides as the caption and the rest
   * follow as plain messages. A quote (`quotedMessageId`) and the ack-clear
   * (`ackMessageId`) both resolve through the recent-message cache, so a
   * message older than that cache simply sends unquoted rather than failing.
   */
  async sendMessage(
    jid: string,
    text: string,
    imagePath?: string,
    opts: {
      /** Quote this inbound message id in the reply (Baileys' `quoted` option). */
      quotedMessageId?: string;
      /** Send the image as an uncompressed document instead of a photo. */
      asDocument?: boolean;
      /** Inbound message id whose ⏳ ack should be cleared once this send lands. */
      ackMessageId?: string;
    } = {},
  ): Promise<void> {
    if (!this.sock || this.status !== 'linked') {
      throw new Error('WhatsApp is not linked');
    }
    const sock = this.sock;
    const quoted = opts.quotedMessageId ? this.recentMessages.get(opts.quotedMessageId) : undefined;
    // Only the FIRST message of a multi-chunk reply quotes the original —
    // repeating the quote block on every chunk is visual noise.
    const firstOpts = quoted ? { quoted } : undefined;
    const mentions = await this.resolveMentions(jid, text);
    const mentionField = mentions ? { mentions } : {};
    // Baileys' third argument is optional — pass it ONLY when there is
    // actually something to say, so an ordinary unquoted send keeps the exact
    // two-argument call shape it had before quoting existed.
    const send = (content: unknown, options?: { quoted: WAMessage }): Promise<unknown> =>
      options
        ? sock.sendMessage(jid, content as Parameters<WASocket['sendMessage']>[1], options)
        : sock.sendMessage(jid, content as Parameters<WASocket['sendMessage']>[1]);
    // An empty text with no image keeps the historical single-send behaviour
    // (chunkText returns [] for '') rather than silently sending nothing.
    const chunks = chunkText(text, MAX_TEXT_CHARS);
    const parts = chunks.length > 0 ? chunks : imagePath ? [] : [text];

    if (imagePath) {
      const stat = await fsp.stat(imagePath).catch(() => null);
      if (!stat) throw new Error(`image not found: ${imagePath}`);

      // Auto-optimize an over-cap PHOTO instead of refusing the whole reply.
      // Deliberately skipped when asDocument is set: that mode exists to
      // deliver the exact bytes (see the forceDocument note below), so
      // recompressing there would defeat the only reason to choose it — an
      // over-cap document still throws, exactly as before.
      //
      // The throw below is kept as a backstop rather than removed: optimizeImage
      // is best-effort and can hand back something still over the cap (a
      // non-image file, sharp unavailable), and silently handing WhatsApp bytes
      // it will reject is worse than a readable error the agent can act on.
      let sendPath = imagePath;
      let sendBytes = stat.size;
      if (sendBytes > MAX_IMAGE_BYTES && !opts.asDocument) {
        sendPath = await optimizeImageFile(imagePath, MAX_IMAGE_BYTES).catch(() => imagePath);
        if (sendPath !== imagePath) {
          sendBytes = (await fsp.stat(sendPath).catch(() => null))?.size ?? sendBytes;
          this.logger.info('Outbound WhatsApp image optimized to fit the size cap', {
            agentId: this.agentConfig.id,
            originalBytes: stat.size,
            optimizedBytes: sendBytes,
          });
        }
      }
      if (sendBytes > MAX_IMAGE_BYTES) {
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
      }
      const caption = parts[0] || undefined;
      // forceDocument: WhatsApp re-compresses anything sent as `image`, which
      // destroys fine detail in screenshots/diagrams the agent generated. Sent
      // as a `document` the exact bytes arrive intact.
      const content = opts.asDocument
        ? {
            document: { url: imagePath },
            mimetype: guessOutboundMimeType(imagePath),
            fileName: path.basename(imagePath),
            caption,
            ...mentionField,
          }
        : { image: { url: sendPath }, caption, ...mentionField };
      await send(content, firstOpts);
      for (const chunk of parts.slice(1)) {
        await send({ text: chunk, ...mentionField });
      }
    } else {
      for (let i = 0; i < parts.length; i++) {
        await send({ text: parts[i]!, ...mentionField }, i === 0 ? firstOpts : undefined);
      }
    }

    if (opts.ackMessageId) {
      await this.clearAckReaction(jid, opts.ackMessageId).catch(() => {});
    }
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
    await this.wipeStateDir();
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
