/**
 * HTTP client for Tencent's iLink Bot API ("WeChat ClawBot") — the real,
 * documented, self-serve protocol behind both source projects this channel
 * was researched from (Hermes-agent's Weixin adapter, OpenClaw's WeChat
 * plugin). The canonical protocol reference is Tencent's own
 * `Tencent/openclaw-weixin` repo (docs/protocol.md), an MIT-licensed,
 * actively-maintained OpenClaw channel plugin published as
 * `@tencent-weixin/openclaw-weixin` — not a third-party paid bridge. No
 * account signup with any company is required: `openclaw channels login`
 * scans a QR with the user's own WeChat app and stores the resulting
 * credentials locally, which is exactly the shape `startLinking()` below
 * mirrors.
 *
 * IMPORTANT caveats carried over from that protocol doc, not filled in here:
 *  - `qrcode_img_content` — confirmed against a real response (2026-09-10):
 *    it is a `liteapp.weixin.qq.com` URL (an `text/html` mini-program deep
 *    link, NOT an image — confirmed by fetching it directly and checking
 *    Content-Type), meant to be scanned as data, not displayed as a
 *    pre-rendered picture. `normalizeQrImage()` below QR-encodes it into an
 *    actual PNG data URI (via the `qrcode` package) so `WeChatStatus.qr`
 *    keeps the same "ready-to-`<img src>`" contract every other device-linked
 *    channel's status already uses (mirrors WhatsApp/Baileys, which does the
 *    same QR-image encoding for its own pairing string).
 *  - `need_verifycode`/`verify_code_blocked` (an extra verification-code
 *    step some accounts hit) has no UI path yet — those statuses currently
 *    fall back to "expired" (ask the user to retry) rather than prompting
 *    for a code. See `pollLinkStatus`'s doc comment.
 *  - Media (image/voice/file/video item types) is out of scope for v1 per
 *    the plan's non-goals — only `text_item` is read/written here.
 */
import * as QRCode from 'qrcode';

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** `base_info.bot_agent` — a short ASCII observability tag, per protocol.md's
 * "sanitized observability identifier... not used for authentication or
 * routing" — analogous to `bot_agent: "OpenClaw"` in Tencent's own examples. */
const BOT_AGENT = 'GetPod';
/** `base_info.channel_version` — this integration's own version, not the
 * gateway's. Bump when this file's request/response handling changes. */
const CHANNEL_VERSION = '1.0.0';

export interface ILinkCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
}

export interface ILinkQrSession {
  /** Data URI (or remote image URL) to render as the login QR. */
  qrDataUri: string;
  /** Opaque handle to poll for this specific login attempt's completion. */
  loginSessionId: string;
}

export interface ILinkLinkResult {
  linked: boolean;
  credentials?: ILinkCredentials;
}

export interface ILinkUpdate {
  /** iLink message id — used for at-least-once delivery de-duplication. */
  id: string;
  /** Sender's iLink user id. */
  fromId: string;
  /** Plain text body, when present. */
  text?: string;
  /** Best-effort display name, when iLink provides one. */
  displayName?: string;
  /** Server timestamp (ms since epoch), when provided. */
  timestamp?: number;
  /**
   * Conversation context token this specific message carries (Tencent's
   * `WeixinMessage.context_token`) — established by an INBOUND message, not
   * minted by sending one. Must be echoed on the next `sendText` call to
   * this same sender. See this module's doc comment for why `sendText`
   * itself no longer returns one.
   */
  contextToken?: string;
}

export interface ILinkClient {
  /** Start a fresh QR login flow. */
  requestLinkQr(): Promise<ILinkQrSession>;
  /** Poll whether a QR login attempt has been completed (scanned + confirmed). */
  pollLinkStatus(loginSessionId: string): Promise<ILinkLinkResult>;
  /**
   * Long-poll for new messages. Resolves with zero or more updates once
   * either a message arrives or `timeoutSeconds` elapses (iLink's documented
   * `getupdates` contract) — never rejects on a plain timeout, only on a real
   * transport/auth failure.
   */
  getUpdates(creds: ILinkCredentials, timeoutSeconds: number): Promise<ILinkUpdate[]>;
  /**
   * Send a single already-chunked text message. `contextToken` is whatever
   * the most recent INBOUND message from this recipient carried (undefined
   * if they've never messaged first) — sending does not return a new one,
   * per Tencent's documented `sendmessage` response (`{ret, errmsg}` only).
   */
  sendText(creds: ILinkCredentials, toId: string, text: string, contextToken?: string): Promise<void>;
}

/** Random uint32 → decimal string → base64, per protocol.md's `X-WECHAT-UIN` spec. */
function randomWechatUin(): string {
  const n = Math.floor(Math.random() * 0x100000000);
  return Buffer.from(String(n), 'utf-8').toString('base64');
}

/**
 * Plugin version as `0x00MMNNPP` (major/minor/patch, one byte each) rendered
 * as a decimal string, per protocol.md's `iLink-App-ClientVersion` spec.
 */
export function encodeClientVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const encoded = ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
  return String(encoded);
}

const CLIENT_VERSION_HEADER = encodeClientVersion(CHANNEL_VERSION);

/**
 * Turn whatever `qrcode_img_content` actually is into a ready-to-`<img src>`
 * PNG data URI. Confirmed shape (see module doc comment): a
 * `liteapp.weixin.qq.com` URL that must itself be QR-encoded — it is data to
 * scan, not a picture to show as-is.
 */
export async function normalizeQrImage(content: string): Promise<string> {
  if (content.startsWith('data:')) return content;
  if (content.startsWith('http://') || content.startsWith('https://')) {
    return QRCode.toDataURL(content, { margin: 1 });
  }
  // Fallback for a shape neither confirmed response nor the doc describes:
  // assume base64-encoded PNG bytes already.
  return `data:image/png;base64,${content}`;
}

interface ILinkFetchOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Omit entirely for the pre-auth QR flow, per protocol.md's header table. */
  botToken?: string;
  baseUrl: string;
}

async function ilinkFetch<T>(opts: ILinkFetchOptions): Promise<T> {
  const url = new URL(opts.path, opts.baseUrl);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION_HEADER,
  };
  // Auth headers are sent for the QR POST too (it still identifies the
  // client), but NOT for the unauthenticated GET status-poll — see
  // protocol.md's "Before auth (QR polling)" header table.
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['AuthorizationType'] = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = randomWechatUin();
  }
  if (opts.botToken) headers['Authorization'] = `Bearer ${opts.botToken}`;

  const res = await fetch(url.toString(), {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`iLink ${opts.method} ${opts.path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface GetBotQrcodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface GetQrcodeStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'need_verifycode' | 'verify_code_blocked' | 'scaned_but_redirect' | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

interface WeixinMessageItem {
  type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video, 11/12=tool-call
  text_item?: { text: string };
}

interface WeixinMessage {
  message_id: string;
  from_user_id: string;
  to_user_id: string;
  create_time_ms?: number;
  message_type: number; // 1=user, 2=bot — only 1 is a real inbound message
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface SendMessageResponse {
  ret: number;
  errmsg?: string;
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** Extract the first text item's body — media items are ignored (out of scope for v1). */
function textFromItems(items: WeixinMessageItem[] | undefined): string | undefined {
  return items?.find((i) => i.type === 1)?.text_item?.text;
}

/**
 * Real implementation — talks to Tencent's iLink Bot API. See this module's
 * doc comment for the two documented ambiguities (`qrcode_img_content`'s
 * encoding, and the unhandled verification-code statuses) still to confirm
 * against a real account.
 */
export function createILinkClient(baseUrl?: string): ILinkClient {
  const qrBaseUrl = baseUrl || DEFAULT_ILINK_BASE_URL;
  // getupdates' cursor must survive across polls — scoped per accountId so
  // one client instance could in principle serve more than one credential
  // set, even though v1 only ever uses it for a single linked account.
  const updateCursors = new Map<string, string>();

  return {
    async requestLinkQr(): Promise<ILinkQrSession> {
      const res = await ilinkFetch<GetBotQrcodeResponse>({
        method: 'POST',
        path: '/ilink/bot/get_bot_qrcode',
        query: { bot_type: '3' },
        body: { local_token_list: [] },
        baseUrl: qrBaseUrl,
      });
      return { qrDataUri: await normalizeQrImage(res.qrcode_img_content), loginSessionId: res.qrcode };
    },

    async pollLinkStatus(loginSessionId: string): Promise<ILinkLinkResult> {
      const res = await ilinkFetch<GetQrcodeStatusResponse>({
        method: 'GET',
        path: '/ilink/bot/get_qrcode_status',
        query: { qrcode: loginSessionId },
        baseUrl: qrBaseUrl,
      });
      if (res.status === 'confirmed' && res.bot_token && res.ilink_bot_id) {
        return {
          linked: true,
          credentials: {
            accountId: res.ilink_bot_id,
            token: res.bot_token,
            baseUrl: res.baseurl || qrBaseUrl,
          },
        };
      }
      // `need_verifycode`/`verify_code_blocked` have no UI path yet (see
      // module doc comment) — surface as "still not linked" so the caller's
      // own attempt-timeout eventually reports back to the user, rather than
      // silently hanging on a status this client can't act on.
      return { linked: false };
    },

    async getUpdates(creds: ILinkCredentials, _timeoutSeconds: number): Promise<ILinkUpdate[]> {
      const cursor = updateCursors.get(creds.accountId) ?? '';
      const res = await ilinkFetch<GetUpdatesResponse>({
        method: 'POST',
        path: '/ilink/bot/getupdates',
        body: { get_updates_buf: cursor, base_info: baseInfo() },
        botToken: creds.token,
        baseUrl: creds.baseUrl,
      });
      if (res.get_updates_buf !== undefined) updateCursors.set(creds.accountId, res.get_updates_buf);
      if (res.ret !== 0) {
        throw new Error(`iLink getupdates failed: ret=${res.ret} errmsg=${res.errmsg ?? 'unknown'}`);
      }
      return (res.msgs ?? [])
        // message_type 2 = the bot's own messages echoed back — never a real
        // inbound message, so treating them as one would make the agent
        // reply to itself.
        .filter((m) => m.message_type === 1)
        .map((m) => ({
          id: m.message_id,
          fromId: m.from_user_id,
          text: textFromItems(m.item_list),
          timestamp: m.create_time_ms,
          contextToken: m.context_token,
        }));
    },

    async sendText(creds: ILinkCredentials, toId: string, text: string, contextToken?: string): Promise<void> {
      const res = await ilinkFetch<SendMessageResponse>({
        method: 'POST',
        path: '/ilink/bot/sendmessage',
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toId,
            client_id: `getpod-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            message_type: 2,
            message_state: 2,
            context_token: contextToken ?? '',
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: baseInfo(),
        },
        botToken: creds.token,
        baseUrl: creds.baseUrl,
      });
      if (res.ret !== 0) {
        throw new Error(`iLink sendmessage failed: ret=${res.ret} errmsg=${res.errmsg ?? 'unknown'}`);
      }
    },
  };
}

/** A deterministic checkerboard SVG, styled to read as "a QR code" at a glance
 * without a real QR-encoding dependency — this fake client never needs to be
 * actually scanned. */
function fakeQrDataUri(seed: string): string {
  const size = 21;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  let cells = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Corner "finder" squares, like a real QR code, plus a pseudo-random fill
      // elsewhere so every fake session looks visually distinct.
      const inFinder =
        (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
      hash = (hash * 1103515245 + 12345) >>> 0;
      const on = inFinder ? (x % 6 !== 3 && y % 6 !== 3) : hash % 2 === 0;
      if (on) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="#000">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>${cells}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Local-testing-only fake client — no network calls, no real iLink account
 * needed. Simulates a QR scan completing after a few polls, then occasionally
 * delivers one fake inbound message (carrying its own fake `contextToken`,
 * exactly like the real protocol) so the pending-sender/access-control UI
 * has something to show. Never wired up by default — see
 * `isWeChatILinkFakeEnabled()` and its call site in AgentRunner.
 *
 * NOT a substitute for the real API contract — exists purely so the apps/web
 * card's UI/UX (QR render, link→linked transition, DM allowlist, disconnect)
 * can be manually verified end-to-end without a real WeChat account.
 */
export function createFakeILinkClient(): ILinkClient {
  let pollCount = 0;
  let updateCount = 0;

  return {
    async requestLinkQr(): Promise<ILinkQrSession> {
      pollCount = 0;
      const loginSessionId = `fake-session-${Date.now()}`;
      return { qrDataUri: fakeQrDataUri(loginSessionId), loginSessionId };
    },

    async pollLinkStatus(loginSessionId: string): Promise<ILinkLinkResult> {
      pollCount += 1;
      // ~3 polls at the manager's 2s interval ⇒ linked after ~6s, long enough
      // to see the QR/"Waiting for scan…" state before it resolves.
      if (pollCount < 3) return { linked: false };
      return {
        linked: true,
        credentials: {
          accountId: 'fake-account',
          token: `fake-token-${loginSessionId}`,
          baseUrl: 'fake://local-test',
        },
      };
    },

    async getUpdates(_creds: ILinkCredentials, timeoutSeconds: number): Promise<ILinkUpdate[]> {
      // Real iLink blocks up to `timeoutSeconds`; a short fixed sleep here
      // keeps manual testing responsive instead of waiting the full 35s.
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutSeconds, 4) * 1000));
      updateCount += 1;
      // One fake message shortly after linking, then quiet — enough to
      // exercise the pending-sender/allowlist flow without spamming.
      if (updateCount === 2) {
        return [
          {
            id: `fake-msg-${Date.now()}`,
            fromId: 'fake-tester',
            text: 'Hi, this is a fake WeChat test message — approve me to keep chatting!',
            displayName: 'Fake Tester',
            timestamp: Date.now(),
            contextToken: 'fake-context-token',
          },
        ];
      }
      return [];
    },

    async sendText(_creds: ILinkCredentials, toId: string, text: string, contextToken?: string): Promise<void> {
      // eslint-disable-next-line no-console -- local-testing-only visibility, not production logging
      console.log(`[fake-ilink] would send to ${toId} (ctx=${contextToken ?? 'none'}): ${text}`);
    },
  };
}

/** Opt-in only, local dev/manual-testing use — see createFakeILinkClient's doc comment. */
export function isWeChatILinkFakeEnabled(): boolean {
  return process.env.WECHAT_ILINK_FAKE === 'true';
}
