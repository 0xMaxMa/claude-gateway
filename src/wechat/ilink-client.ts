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
 *  - Media: inbound IMAGES (item type 2) are downloaded + decrypted (see
 *    `resolveWeixinImageRef`/`downloadWeixinImage` below, confirmed live
 *    2026-09-11 against protocol.md + `NousResearch/hermes-agent`'s working
 *    Python implementation). Voice/file/video (types 3/4/5) and ALL outbound
 *    media sending are still out of scope — only `text_item` is written.
 */
import * as crypto from 'crypto';
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
  /**
   * The raw status string Tencent returned (`wait`/`scaned`/`confirmed`/
   * `expired`/`need_verifycode`/`verify_code_blocked`/`scaned_but_redirect`/
   * `binded_redirect`), surfaced purely for operational logging — nothing
   * downstream branches on it besides `linked` above. Added after a live
   * link attempt where the confirm button was tapped but nothing here ever
   * saw `confirmed`, with zero visibility into which of these statuses it
   * actually got stuck on.
   */
  status?: string;
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
  /** Present when this message carries an inbound image (item type 2). Download+decrypt via `downloadWeixinImage()`. */
  image?: ILinkImageRef;
  /** Present when this message carries an inbound file (item type 4, e.g. a PDF). Download+decrypt via `downloadWeixinImage()`, same as an image. */
  file?: ILinkFileRef;
}

/** Resolved download target for an inbound image, from `resolveWeixinImageRef()`. */
export interface ILinkImageRef {
  url: string;
  /** Absent means the bytes at `url` are already plaintext. */
  aesKey?: Buffer;
  /**
   * Sender-declared plaintext byte count (`file_item.len` — files only, per
   * protocol.md). When set and the decrypted buffer is longer than this,
   * `downloadWeixinImage` keeps the trailing `expectedLength` bytes and
   * drops the rest as a leading prefix — confirmed live 2026-09-11: a real
   * decrypted PDF carried 3 extra bytes before its `%PDF-` header despite a
   * byte-perfect key/cipher (images never show this, only files), so
   * WeChat's file upload path evidently prepends a few bytes ahead of the
   * real content that protocol.md doesn't document.
   */
  expectedLength?: number;
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
  /**
   * Tell iLink's backend this channel client has started, before the first
   * `getUpdates` call — confirmed via Tencent's own official client
   * (`Tencent/openclaw-weixin`'s `src/channel.ts`, checked 2026-09-10): it
   * calls this unconditionally before starting its poll loop, and
   * protocol.md documents it as "notify the backend that the client
   * started." This codebase never called it at all, which is the likely
   * cause of `getUpdates` failing (Cloudflare 522/524) on the large
   * majority of polls during live testing — never confirmed as THE fix
   * (Tencent's own docs don't spell out what not calling it does), but it's
   * a real gap versus the reference implementation, not a stretch. Failure
   * here must never block startup — Tencent's own client only logs a
   * warning and continues (see `notifyStart`'s call site in manager.ts).
   */
  notifyStart(creds: ILinkCredentials): Promise<void>;
  /** Counterpart to notifyStart, sent on channel stop. Same non-blocking contract. */
  notifyStop(creds: ILinkCredentials): Promise<void>;
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
  /**
   * Hard cap on this single request, in ms. Without this, a slow/unresponsive
   * host (observed live: `get_qrcode_status`'s `redirect_host` after
   * `scaned_but_redirect`) hangs `fetch()` forever with no error and no
   * timeout — which stalls the entire `startLinking()` poll loop silently
   * (the loop's own deadline check only runs BETWEEN awaited calls, so it
   * never fires while stuck inside one). Defaults to 15s; `getUpdates`
   * overrides this to cover its own documented long-poll window.
   */
  timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * `redirect_host` (and `baseurl` on a `confirmed` response) — confirmed live
 * (2026-09-10) to arrive as a bare host, e.g. `ilinkai2.weixin.qq.com`, NOT a
 * full `https://...` URL as protocol.md's naming implies. `new URL(path,
 * base)` throws "Invalid URL" on a schemeless base, which silently wedged
 * every poll after a real scan forever (the retry loop in
 * WeChatManager.startLinking keeps calling this same host, gets the same
 * throw every time, and only the attempt's 2-minute deadline ever ends it).
 */
function normalizeIlinkHost(host: string): string {
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

async function ilinkFetch<T>(opts: ILinkFetchOptions): Promise<T> {
  let url: URL;
  try {
    url = new URL(opts.path, opts.baseUrl);
  } catch {
    // Bare `new URL()` errors ("Invalid URL") carry no context — surface
    // which baseUrl actually failed, since this is exactly what a malformed
    // `redirect_host`/`baseurl` from iLink looks like (see normalizeIlinkHost).
    throw new Error(`iLink ${opts.method} ${opts.path}: invalid baseUrl "${opts.baseUrl}"`);
  }
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION_HEADER,
    // Force a fresh connection per request instead of reusing Node's
    // undici keep-alive pool. Confirmed root cause, sourced from a second
    // independent reference implementation (Hermes-agent's
    // `gateway/platforms/weixin.py`, `_make_ssl_connector()`): "proxies like
    // Cloudflare Warp leave peer-initiated FIN in CLOSE_WAIT" — a pooled
    // keep-alive connection can go stale (closed server-side) without the
    // client noticing, and a later request reusing it just hangs/fails.
    // Hermes-agent works around this with a 2s keepalive_timeout; the
    // simpler equivalent here is to never keep the connection alive at all.
    Connection: 'close',
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

  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`iLink ${opts.method} ${opts.path}: timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  /**
   * Present on `scaned_but_redirect` per protocol.md ("Continue polling at
   * redirect_host when present") — subsequent polls for this SAME
   * loginSessionId must go to this host instead, or the flow can silently
   * dead-end (polling the original host forever, always getting the same
   * pre-redirect status back, even after the user taps Confirm on their
   * phone). See `pollLinkStatus`'s `redirectHosts` map below.
   */
  redirect_host?: string;
}

interface WeixinMessageItem {
  type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video, 11/12=tool-call
  text_item?: { text: string };
  /**
   * Present on a type=2 (image) item. `aeskey` (raw 32 hex chars) takes
   * precedence over `media.aes_key` (base64 of either 16 raw bytes or a
   * 32-char hex string) per protocol.md — see `resolveWeixinImageRef`.
   */
  image_item?: {
    aeskey?: string;
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      full_url?: string;
    };
  };
  /**
   * Present on a type=4 (file) item. Unlike `image_item`, protocol.md
   * documents no top-level `aeskey` for files — the key comes from
   * `media.aes_key` only. `file_name` is the attachment's real name
   * (including extension), needed to stage it usefully.
   */
  file_item?: {
    file_name?: string;
    /** Plaintext byte count, as a decimal string, per protocol.md. */
    len?: string;
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      full_url?: string;
    };
  };
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

/** Extract the first text item's body — image items are handled separately by resolveWeixinImageRef; voice/file/video are still ignored. */
function textFromItems(items: WeixinMessageItem[] | undefined): string | undefined {
  return items?.find((i) => i.type === 1)?.text_item?.text;
}

/**
 * Hosts Tencent actually serves inbound-media downloads from, per
 * `NousResearch/hermes-agent`'s `gateway/platforms/weixin.py`
 * (`_WEIXIN_CDN_ALLOWLIST`, confirmed live 2026-09-11). Only checked against
 * a server-supplied `full_url` — a URL built from `encrypt_query_param`
 * against `DEFAULT_CDN_BASE_URL` below doesn't need it (that host is our own
 * trusted constant). This is an SSRF guard: without it, a malicious/buggy
 * `full_url` could point this server's own outbound fetch at an arbitrary
 * internal host.
 */
const WEIXIN_CDN_ALLOWLIST = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
  // Confirmed live 2026-09-11: real `image_item.media.full_url` responses use
  // the `.wechat.com` domain family, not `.weixin.qq.com` — same mismatch
  // class as `redirect_host` earlier this session (docs/Hermes-agent's own
  // allowlist assumed `.weixin.qq.com`; our own post-link `baseUrl` for
  // authenticated calls is ALSO `ilinkai.wechat.com`, confirming this is the
  // real production domain, not a one-off).
  'novac2c.cdn.wechat.com',
  'ilinkai.wechat.com',
]);

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * Decode an inbound AES key from its `media.aes_key` (base64) encoding.
 * protocol.md: "the download decoder accepts base64 of either 16 raw bytes
 * or a 32-character hexadecimal key" — both shapes are used in practice.
 */
function parseAesKeyBase64(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const text = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex');
  }
  throw new Error(`iLink image: unrecognized aes_key encoding (${decoded.length} bytes decoded)`);
}

/**
 * Resolve an inbound image item (type=2) into a download URL + AES key, or
 * `undefined` if `items` carries no image. Throws if a server-supplied
 * `full_url` host isn't in `WEIXIN_CDN_ALLOWLIST` — callers must not let that
 * abort processing of the rest of the batch (see `getUpdates`'s try/catch).
 */
interface WeixinMediaBlock {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

/**
 * Shared URL+key resolution for any media item's `media` block. `rawHexKey`
 * is the item-type-specific top-level key field when one exists (only
 * `image_item.aeskey` per protocol.md — files have no equivalent, so callers
 * for other item types pass `undefined`).
 */
function resolveMediaRef(media: WeixinMediaBlock | undefined, rawHexKey: string | undefined): ILinkImageRef | undefined {
  let aesKey: Buffer | undefined;
  if (rawHexKey && /^[0-9a-fA-F]{32}$/.test(rawHexKey)) {
    aesKey = Buffer.from(rawHexKey, 'hex');
  } else if (media?.aes_key) {
    aesKey = parseAesKeyBase64(media.aes_key);
  }

  let url: string | undefined;
  if (media?.full_url) {
    const host = new URL(media.full_url).hostname;
    if (!WEIXIN_CDN_ALLOWLIST.has(host)) {
      throw new Error(`iLink media: refusing to download from non-allowlisted host "${host}"`);
    }
    url = media.full_url;
  } else if (media?.encrypt_query_param) {
    url = `${DEFAULT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }

  return url ? { url, aesKey } : undefined;
}

export function resolveWeixinImageRef(items: WeixinMessageItem[] | undefined): ILinkImageRef | undefined {
  const item = items?.find((i) => i.type === 2 && i.image_item);
  if (!item?.image_item) return undefined;
  return resolveMediaRef(item.image_item.media, item.image_item.aeskey);
}

export interface ILinkFileRef extends ILinkImageRef {
  /** Attachment's real filename (including extension), e.g. "report.pdf". */
  fileName: string;
}

/** Resolve an inbound file item (type=4) — protocol.md has no top-level aeskey for files, only media.aes_key. */
export function resolveWeixinFileRef(items: WeixinMessageItem[] | undefined): ILinkFileRef | undefined {
  const item = items?.find((i) => i.type === 4 && i.file_item);
  if (!item?.file_item) return undefined;
  const ref = resolveMediaRef(item.file_item.media, undefined);
  if (!ref) return undefined;
  const expectedLength = item.file_item.len ? parseInt(item.file_item.len, 10) : undefined;
  return {
    ...ref,
    fileName: item.file_item.file_name || 'file',
    expectedLength: Number.isFinite(expectedLength) ? expectedLength : undefined,
  };
}

/**
 * AES-128-ECB decrypt with PERMISSIVE PKCS#7 unpadding: if the trailing
 * padding doesn't validate, return the padded bytes as-is instead of
 * throwing. Mirrors `NousResearch/hermes-agent`'s `_aes128_ecb_decrypt`
 * exactly (confirmed live 2026-09-11) — Node's built-in auto-unpad
 * (`setAutoPadding(true)`) throws "bad decrypt" on the same real-world edge
 * cases Hermes-agent's own implementation was written to tolerate.
 */
export function aes128EcbDecryptPermissive(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (padded.length === 0) return padded;
  const padLen = padded[padded.length - 1];
  if (padLen >= 1 && padLen <= 16 && padded.length >= padLen) {
    const tail = padded.subarray(padded.length - padLen);
    if (tail.every((b) => b === padLen)) return padded.subarray(0, padded.length - padLen);
  }
  return padded;
}

/**
 * Download (and decrypt, if `ref.aesKey` is set) an inbound image's bytes.
 * No bot-token auth — protocol.md documents this as a plain CDN GET against
 * a pre-signed/scoped URL.
 */
/** 20 MB — matches MediaStore.maxUploadBytes (not imported directly: ilink-client is a
 * protocol-layer module and shouldn't depend on history/media-store's storage layer). */
const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export async function downloadWeixinImage(
  ref: ILinkImageRef,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    // redirect: 'manual' — WEIXIN_CDN_ALLOWLIST only validates ref.url's OWN
    // host; fetch()'s default 'follow' would silently chase a redirect to
    // any other host, defeating that check as an SSRF guard. A redirect
    // response here is treated as a hard failure rather than re-validated,
    // since the legitimate CDN paths (both the trusted default base and an
    // allowlisted full_url) are not expected to redirect at all.
    res = await fetch(ref.url, { signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new Error('iLink media download: refusing to follow a redirect (SSRF guard)');
  }
  if (!res.ok) {
    throw new Error(`iLink image download: HTTP ${res.status}`);
  }
  // Reject on the declared size before buffering the body when the server
  // tells us upfront (LINE's webhook router enforces the same cap the same
  // way — see MAX_MEDIA_BYTES's declaredSize check there).
  const declaredLength = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`iLink media download: declared size ${declaredLength} exceeds ${maxBytes} byte cap`);
  }
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > maxBytes) {
    throw new Error(`iLink media download: ${raw.length} bytes exceeds ${maxBytes} byte cap`);
  }
  const decrypted = ref.aesKey ? aes128EcbDecryptPermissive(raw, ref.aesKey) : raw;
  // See ILinkImageRef.expectedLength's doc comment — trims a leading prefix
  // WeChat's file-upload path adds ahead of the real content.
  if (ref.expectedLength !== undefined && decrypted.length > ref.expectedLength) {
    return decrypted.subarray(decrypted.length - ref.expectedLength);
  }
  return decrypted;
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
  // Which host to poll get_qrcode_status on next, per in-flight login
  // attempt — starts at qrBaseUrl, switches once `redirect_host` is seen
  // (see GetQrcodeStatusResponse's doc comment on that field for why this
  // exists at all).
  const qrStatusHosts = new Map<string, string>();

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
      const pollHost = qrStatusHosts.get(loginSessionId) ?? qrBaseUrl;
      const res = await ilinkFetch<GetQrcodeStatusResponse>({
        method: 'GET',
        path: '/ilink/bot/get_qrcode_status',
        query: { qrcode: loginSessionId },
        baseUrl: pollHost,
      });
      if (res.status === 'scaned_but_redirect' && res.redirect_host) {
        qrStatusHosts.set(loginSessionId, normalizeIlinkHost(res.redirect_host));
      }
      if (res.status === 'confirmed' && res.bot_token && res.ilink_bot_id) {
        qrStatusHosts.delete(loginSessionId);
        return {
          linked: true,
          status: res.status,
          credentials: {
            accountId: res.ilink_bot_id,
            token: res.bot_token,
            baseUrl: res.baseurl ? normalizeIlinkHost(res.baseurl) : qrBaseUrl,
          },
        };
      }
      // `need_verifycode`/`verify_code_blocked` have no UI path yet (see
      // module doc comment) — surface as "still not linked" so the caller's
      // own attempt-timeout eventually reports back to the user, rather than
      // silently hanging on a status this client can't act on.
      return { linked: false, status: res.status };
    },

    async getUpdates(creds: ILinkCredentials, _timeoutSeconds: number): Promise<ILinkUpdate[]> {
      const cursor = updateCursors.get(creds.accountId) ?? '';
      const res = await ilinkFetch<GetUpdatesResponse>({
        method: 'POST',
        path: '/ilink/bot/getupdates',
        body: { get_updates_buf: cursor, base_info: baseInfo() },
        botToken: creds.token,
        baseUrl: creds.baseUrl,
        // iLink's own long-poll legitimately blocks up to _timeoutSeconds —
        // give it headroom above that instead of the 15s default meant for
        // quick request/response calls.
        timeoutMs: _timeoutSeconds * 1000 + 10_000,
      });
      if (res.get_updates_buf !== undefined) updateCursors.set(creds.accountId, res.get_updates_buf);
      // `ret` is OMITTED entirely on a successful response (confirmed live
      // 2026-09-10 — every real getupdates success we captured had no `ret`
      // field at all, just `msgs`/`get_updates_buf`), matching protocol.md's
      // explicit rule for sendMessage ("an absent ret does not trigger this
      // check") which applies the same way here. The old `res.ret !== 0`
      // check was true for `undefined` too, so it threw "ret=undefined" on
      // every single successful call — the actual reason messages we KNEW
      // existed (confirmed via a raw curl to the same account) never made it
      // through this client.
      if (res.ret !== undefined && res.ret !== 0) {
        throw new Error(`iLink getupdates failed: ret=${res.ret} errmsg=${res.errmsg ?? 'unknown'}`);
      }
      return (res.msgs ?? [])
        // message_type 2 = the bot's own messages echoed back — never a real
        // inbound message, so treating them as one would make the agent
        // reply to itself.
        .filter((m) => m.message_type === 1)
        .map((m) => {
          let image: ILinkImageRef | undefined;
          let file: ILinkFileRef | undefined;
          try {
            image = resolveWeixinImageRef(m.item_list);
          } catch {
            // A malformed item or a non-allowlisted full_url (SSRF guard)
            // must not drop the whole batch — this one message just arrives
            // without its image, same as any other undeliverable-media case.
            image = undefined;
          }
          try {
            file = resolveWeixinFileRef(m.item_list);
          } catch {
            file = undefined;
          }
          return {
            id: m.message_id,
            fromId: m.from_user_id,
            text: textFromItems(m.item_list),
            timestamp: m.create_time_ms,
            contextToken: m.context_token,
            image,
            file,
          };
        });
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
      // Same fix as getUpdates above — confirmed live: a successful
      // sendmessage response is just `{"message_id": ...}`, no `ret` field
      // at all. Per protocol.md: "A non-zero ret throws; an absent ret does
      // not trigger this check."
      if (res.ret !== undefined && res.ret !== 0) {
        throw new Error(`iLink sendmessage failed: ret=${res.ret} errmsg=${res.errmsg ?? 'unknown'}`);
      }
    },

    async notifyStart(creds: ILinkCredentials): Promise<void> {
      await ilinkFetch<{ ret?: number; errmsg?: string }>({
        method: 'POST',
        path: '/ilink/bot/msg/notifystart',
        body: { base_info: baseInfo() },
        botToken: creds.token,
        baseUrl: creds.baseUrl,
        timeoutMs: 10_000,
      });
    },

    async notifyStop(creds: ILinkCredentials): Promise<void> {
      await ilinkFetch<{ ret?: number; errmsg?: string }>({
        method: 'POST',
        path: '/ilink/bot/msg/notifystop',
        body: { base_info: baseInfo() },
        botToken: creds.token,
        baseUrl: creds.baseUrl,
        timeoutMs: 10_000,
      });
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

    async notifyStart(): Promise<void> {},
    async notifyStop(): Promise<void> {},
  };
}

/** Opt-in only, local dev/manual-testing use — see createFakeILinkClient's doc comment. */
export function isWeChatILinkFakeEnabled(): boolean {
  return process.env.WECHAT_ILINK_FAKE === 'true';
}
