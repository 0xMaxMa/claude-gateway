/**
 * LINE inbound webhook handler (openclaw-style: LINE is webhook-only, no polling).
 *
 * Exposed as a WebhookAppHandler ({ verify, handlePost }) wired into the unified
 * `/webhooks/:app` dispatcher (see webhooks-router.ts) under app "line". The
 * dispatcher mounts BEFORE express.json() and applies express.raw, so the raw
 * request bytes are available for signature validation (LINE signs the raw body;
 * a re-serialized parsed body would not match).
 *
 * Flow: verify x-line-signature → 200 → for each handled message (text, image,
 * file) from an allowed source, show a loading animation and forward a normalized
 * {content, meta} to the target agent's existing /channel callback (the same
 * intake Telegram uses). Image and file bytes are fetched via the blob API and
 * surfaced as meta.image_path.
 */
import { type Request, type Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateSignature, messagingApi, type webhook } from '@line/bot-sdk';
import type { AgentRunner } from '../agent/runner';
import { createLogger } from '../logger';
import {
  isResolvedSourceAllowed,
  resolveLineSource,
  type ResolvedLineSource,
} from './line-access';
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSender,
  generatePairingCode,
} from './pending-senders';
import { wasBotMentioned, type LineMessageLike } from './line-mention';
import { MediaStore } from '../history/media-store';
import { sniffImageExt } from '../shared/image-sniff';
import type { WebhookAppHandler } from './webhooks-router';

const LOADING_SECONDS = 20; // 5..60, multiple of 5; 1:1 chats only
// Inbound media cap — images and files alike. Sourced from MediaStore, which is
// where the downloaded bytes end up — a router-local literal could drift into
// accepting media the store then rejects.
const MAX_MEDIA_BYTES = MediaStore.maxUploadBytes;

/** A sane public hostname: letters, digits, dot, hyphen, optional :port. */
const HOST_RE = /^[A-Za-z0-9.\-:]+$/;

/** Extract host[:port] from a configured publicUrl (e.g. "https://vm.example.com/gateway"
 *  → "vm.example.com"). Returns '' when unset or unparseable so the caller falls
 *  back to the request host. */
function hostFromPublicUrl(publicUrl: string | undefined): string {
  if (!publicUrl) return '';
  try {
    return new URL(publicUrl).host;
  } catch {
    return '';
  }
}

/**
 * Persist the gateway's own public base URL (derived from the inbound LINE
 * webhook request) to `<workspace>/../.public-base`, which the `line_image` MCP
 * tool reads at call-time to build `/shared/<token>` URLs (the token is minted
 * via the gateway share bridge). This removes the need for any public-base-URL
 * env var.
 *
 * Scheme is hardcoded `https`: the pod's Traefik `web-vm` entrypoint does NOT
 * trust forwarded headers, so X-Forwarded-Proto arrives as `http` (wrong). The
 * Host header IS reliable (pod FQDN).
 *
 * Defensive by contract: validates the host, only rewrites when the content
 * changed (avoids I/O per message), writes atomically (temp + rename), and never
 * throws — a failure here must not break webhook handling.
 */
function persistPublicBase(
  workspace: string,
  host: string,
  logger: ReturnType<typeof createLogger>,
): void {
  try {
    const h = (host.split(',')[0] ?? '').trim();
    if (!h || !HOST_RE.test(h)) {
      logger.debug('LINE webhook: skip .public-base (invalid/empty host)', { host });
      return;
    }
    const base = `https://${h}/gateway`;
    const target = path.resolve(workspace, '..', '.public-base');
    let current = '';
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch {
      current = '';
    }
    if (current === base) return;
    const tmp = path.join(path.dirname(target), `.public-base.${process.pid}.tmp`);
    fs.writeFileSync(tmp, base, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.debug('LINE webhook: .public-base write failed', { error: (err as Error).message });
  }
}

/**
 * Extensions a browser would treat as ACTIVE content. A staged file is reachable
 * over the authenticated media endpoint (`GET /api/agents/:id/media/*`, which
 * hands the extension to `res.sendFile` and so to Express's Content-Type lookup),
 * so a sender-named `x.html` or `x.svg` opened from the UI would execute script on
 * the gateway's own origin. Naming them `bin` costs nothing — the bytes still reach
 * the agent unchanged, and that endpoint content-sniffs a `.bin` against image/PDF
 * magic only, falling back to application/octet-stream. This is a denylist by
 * necessity (an allowlist would degrade every legitimate but unlisted document
 * type), so it is the second line: `X-Content-Type-Options: nosniff` on that
 * endpoint is the first.
 *
 * NOT hand-picked — that is how the first cut of this list ended up denying `xml`
 * and `xsl` while letting `xsd` and `rng` through, which `mime` resolves to the
 * very same `application/xml`. The list below is DERIVED from the table
 * `res.sendFile` actually consults (`mime@1.6.0`'s `types.json`, reached via
 * express → send), taking every extension whose type is:
 *
 *   - HTML            — `text/html`, `application/xhtml+xml`
 *   - XML-parsed      — `text/xml`, `application/xml`, `application/xml-dtd`, and
 *                       anything with a `+xml` suffix, which Blink's
 *                       `IsXMLMIMEType` renders through the XML parser and so
 *                       honours an `<?xml-stylesheet?>` PI (XSLT → scripted HTML)
 *   - script / style  — any `javascript` / `ecmascript` subtype, and `text/css`
 *
 * plus the server-side extensions (`php`, `jsp`, `asp*`, `hta`) that predate the
 * derivation. Regenerate after an express/send major bump — the suffix guard in
 * `isBrowserActiveExt` covers new `*htm`/`*html`/`*xml` spellings until then.
 */
const BROWSER_ACTIVE_EXTS = new Set([
  'asp', 'aspx', 'atom', 'atomcat', 'atomsvc', 'ccxml', 'cdxml', 'cjs', 'css', 'dae',
  'davmount', 'dbk', 'dd2', 'dtb', 'dtd', 'ecma', 'emma', 'es3', 'et3', 'gml', 'gpx',
  'grxml', 'hal', 'hta', 'htm', 'html', 'ink', 'inkml', 'irp', 'js', 'jsp', 'kml',
  'lasxml', 'lbe', 'link66', 'lostxml', 'mads', 'mathml', 'meta4', 'metalink', 'mets',
  'mjs', 'mods', 'mpd', 'mpkg', 'mrcx', 'mscml', 'musicxml', 'mxml', 'ncx', 'omdoc', 'opf',
  'osfpvg', 'php', 'pls', 'pskcxml', 'rdf', 'res', 'rif', 'rl', 'rld', 'rng', 'rs', 'rsd',
  'rss', 'sbml', 'sdkd', 'sdkm', 'shf', 'shtm', 'shtml', 'smi', 'smil', 'sru', 'srx',
  'ssdl', 'ssml', 'svg', 'svgz', 'tei', 'teicorpus', 'tfi', 'uoml', 'uvt', 'uvvt', 'vxml',
  'wadl', 'wbs', 'wsdl', 'wspolicy', 'x3d', 'x3dz', 'xaml', 'xdf', 'xdm', 'xdp', 'xdssc',
  'xenc', 'xer', 'xht', 'xhtml', 'xhvml', 'xlf', 'xml', 'xop', 'xpl', 'xsd', 'xsl', 'xslt',
  'xsm', 'xspf', 'xul', 'xvm', 'xvml', 'yin', 'zaz', 'zmm',
]);

/**
 * True when serving a file under this extension could execute script on the
 * gateway's origin. The trailing-family test is deliberate belt-and-braces: a
 * future `types.json` entry like `dhtml` or `foo.xml` variant lands in the same
 * two dangerous families, and this catches it without a code change.
 */
function isBrowserActiveExt(ext: string): boolean {
  return BROWSER_ACTIVE_EXTS.has(ext) || /(?:htm|html|xml)$/.test(ext);
}

/**
 * Extension for an inbound LINE **file**, derived from the sender-supplied name.
 *
 * LINE reports NO MIME type on `file` message events (an image's type can be
 * sniffed from its bytes; a document's cannot), so the name is the only signal —
 * and it is untrusted webhook input. Treat it as hostile: take the last
 * dot-segment, lowercase it, and accept it only when it is a short alphanumeric
 * run that a browser will not execute. Anything else — traversal segments, path
 * separators, percent-escapes, spaces, an over-long suffix, no suffix at all, or
 * an active-content type — degrades to `bin` rather than reaching the filesystem.
 * A multi-part suffix collapses to its last part ("archive.tar.gz" → "gz"), which
 * is enough for the agent to recognise the file.
 */
export function safeFileExt(fileName: string | undefined | null): string {
  const raw = typeof fileName === 'string' ? fileName : '';
  const dot = raw.lastIndexOf('.');
  // dot <= 0 covers both "no suffix" and a leading-dot name (".env" has no ext).
  if (dot <= 0 || dot === raw.length - 1) return 'bin';
  const ext = raw.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return 'bin';
  return isBrowserActiveExt(ext) ? 'bin' : ext;
}

/**
 * The sender-supplied file name as surfaced to the agent (`meta.attachment_name`).
 *
 * This string is echoed into the `<channel>` XML the model reads, where
 * `buildChannelXml` escapes only `"` — so strip the control characters and angle
 * brackets that could otherwise forge tag structure, collapse whitespace, and cap
 * the length. It is a LABEL only: the staging path is always built from the
 * message id (see `mediaTempPath`), never from this value. Returns '' when
 * nothing usable survives, and the caller then omits the meta key entirely.
 */
export function safeAttachmentName(fileName: string | undefined | null): string {
  const raw = typeof fileName === 'string' ? fileName : '';
  return raw
    // Control characters (newlines included) and the angle brackets that could
    // forge `<channel ...>` structure in the prompt. Replaced with a space rather
    // than removed, so "a\nb.pdf" cannot silently become the different name
    // "ab.pdf".
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
}

/**
 * Staging path for inbound media. The message id is squeezed to a safe token so a
 * hostile id can never steer the write out of the temp directory — the id is
 * signature-verified webhook input, but the path is built defensively anyway.
 */
function mediaTempPath(prefix: string, messageId: string): string {
  const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
  return path.join(os.tmpdir(), `${prefix}-${safeId}-${Date.now()}.tmp`);
}

/**
 * Media rejected for size — a distinct type so the caller can tell the agent WHY
 * the bytes are missing without echoing a raw error string into the prompt.
 */
class MediaTooLargeError extends Error {
  constructor() {
    super(`media exceeds ${MAX_MEDIA_BYTES} byte cap`);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Stream inbound media bytes into `dest`, enforcing MAX_MEDIA_BYTES, then rename
 * to the final extension. `resolveExt` is called once with the first chunk —
 * images sniff their type from the bytes, files take it from the sanitised name.
 *
 * Returns the final absolute path, or null when the stream carried no bytes.
 *
 * EVERY failure path — the cap, a mid-transfer socket error, a full disk — closes
 * the write handle and removes the partial `.tmp` before rethrowing. Without that
 * an interrupted transfer leaks a file descriptor for the lifetime of the process
 * and leaves the partial file behind: nothing sweeps `os.tmpdir()`, and a caller
 * that swallows the throw (handlePost does, to keep forwarding the turn) would
 * never notice.
 */
async function drainToFile(
  stream: AsyncIterable<Buffer | string>,
  dest: string,
  resolveExt: (firstChunk: Buffer) => string,
): Promise<string | null> {
  const fileStream = fs.createWriteStream(dest);
  let total = 0;
  let ext = 'bin';
  let firstChunk = true;
  try {
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX_MEDIA_BYTES) {
        // Stop pulling bytes we are going to discard; the catch below closes the
        // file handle and unlinks the partial write.
        (stream as { destroy?: () => void }).destroy?.();
        throw new MediaTooLargeError();
      }
      if (firstChunk) { ext = resolveExt(b); firstChunk = false; }
      fileStream.write(b);
    }
    await new Promise<void>((resolve, reject) => fileStream.end((err?: Error | null) => err ? reject(err) : resolve()));
  } catch (err) {
    // Wait for 'close' before unlinking. fs.createWriteStream opens its fd on the
    // thread pool, so a failure this early can still have an open() in flight —
    // removing the path first just lets that open recreate it, leaving an empty
    // file behind (and the handle open until GC).
    await new Promise<void>((resolve) => {
      if (fileStream.closed) { resolve(); return; }
      fileStream.once('close', () => resolve());
      fileStream.destroy();
    });
    fs.rmSync(dest, { force: true });
    throw err;
  }
  if (total === 0) { fs.rmSync(dest, { force: true }); return null; }
  const finalDest = dest.replace(/\.tmp$/, `.${ext}`);
  fs.renameSync(dest, finalDest);
  return finalDest;
}

/**
 * Fetch an inbound LINE image's bytes via the blob (data) API and write them to
 * a temp file, returning its absolute path. The runner copies this into the
 * agent's permanent MediaStore and tells the agent to Read it (meta.image_path).
 * Returns null on failure; the turn still forwards (agent sees the text/empty).
 */
async function downloadLineImage(
  blobClient: messagingApi.MessagingApiBlobClient,
  messageId: string,
): Promise<string | null> {
  const stream = await blobClient.getMessageContent(messageId);
  return drainToFile(
    stream as AsyncIterable<Buffer | string>,
    mediaTempPath('line-img', messageId),
    (first) => sniffImageExt(first),
  );
}

/**
 * Fetch an inbound LINE **file** (PDF, ZIP, docs, …) the same way, with the
 * extension derived from the sender-supplied name instead of sniffed bytes.
 *
 * `declaredSize` is LINE's own `fileSize` on the event: reject on it up front so
 * an oversized document is never pulled over the wire at all (the same early-reject
 * Slack does on `content-length`, src/api/slack-webhook-router.ts:85-88). It is a
 * cheap optimisation, not the guard — `drainToFile` re-enforces the cap while
 * reading, so a missing or understated value cannot blow past it.
 */
async function downloadLineFile(
  blobClient: messagingApi.MessagingApiBlobClient,
  messageId: string,
  fileName: string | undefined,
  declaredSize?: number,
): Promise<string | null> {
  if (Number.isFinite(declaredSize) && (declaredSize as number) > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError();
  }
  const ext = safeFileExt(fileName);
  const stream = await blobClient.getMessageContent(messageId);
  return drainToFile(
    stream as AsyncIterable<Buffer | string>,
    mediaTempPath('line-file', messageId),
    () => ext,
  );
}

/**
 * One-time pairing-code message. The code is a VISUAL-MATCH token: the sender
 * reports it to the admin, who matches it against the UI before adding them to
 * the allowlist. The sender does NOT reply with it — say so explicitly so they
 * don't paste it back expecting an automated unlock. Bilingual TH/EN.
 */
function pairingMessage(code: string, kind: 'user' | 'group' | 'room' | 'other'): string {
  const inGroup = kind === 'group' || kind === 'room';
  const thWhere = inGroup ? 'ในกลุ่มนี้' : '';
  const enWhere = inGroup ? ' in this group' : '';
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท${thWhere} (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access${enWhere}. (No need to reply with it.)`
  );
}

export type NormalizedLineMessage = {
  content: string;
  meta: Record<string, string>;
};

/**
 * Normalize a LINE webhook event into the gateway's {content, meta} intake shape.
 * Returns null for anything we don't handle (message types other than text/image/
 * file, or a source we can't key a conversation on).
 *
 * `resolved` lets the caller pass the source it already resolved for the access
 * gate, so a single event isn't re-parsed; omitted, it resolves here.
 */
export function normalizeLineEvent(
  event: webhook.Event,
  resolved?: ResolvedLineSource,
): NormalizedLineMessage | null {
  if (event.type !== 'message') return null;
  const msg = (event as webhook.MessageEvent).message;
  // Text, image, and file are handled. Image/file bytes are fetched separately in
  // handlePost (via the LINE blob API) and surfaced to the agent through
  // meta.image_path — the generic "local path the agent should Read" channel,
  // which the runner stages into MediaStore regardless of media kind.
  if (!msg || (msg.type !== 'text' && msg.type !== 'image' && msg.type !== 'file')) return null;
  // Accept 1:1 user, group, and room sources. chat_id is the conversation key
  // (userId / groupId / roomId — the reply/push target); user_id is the human
  // who sent it (may be absent in groups → falls back to the conversation id).
  const { conversationId, senderId, kind } = resolved ?? resolveLineSource(event.source);
  if (kind === 'other' || !conversationId) return null;

  const sender = senderId || conversationId;
  const text = msg.type === 'text' ? ((msg as webhook.TextMessageContent).text ?? '') : '';
  const meta: Record<string, string> = {
    source: 'line',
    chat_id: conversationId,
    user_id: sender,
    user: sender,
    message_id: String(msg.id ?? ''),
    ts: new Date(event.timestamp ?? Date.now()).toISOString(),
    line_chat_type: kind, // 'user' | 'group' | 'room'
  };
  if (msg.type === 'image') meta.media_type = 'image';
  let content = text;
  if (msg.type === 'file') {
    const file = msg as webhook.FileMessageContent;
    meta.media_type = 'file';
    // `attachment_kind` is a cross-channel vocabulary the model reads off the
    // <channel> tag, not a LINE-specific label — Telegram already emits
    // 'document' for a generic file (mcp/tools/telegram/receiver-server.ts), so
    // match it rather than teaching the agent a second word for the same thing.
    meta.attachment_kind = 'document';
    const name = safeAttachmentName(file.fileName);
    if (name) meta.attachment_name = name;
    // A LINE file message carries no caption. Without a placeholder `content`
    // would be empty, and the runner labels an empty content with an image_path
    // as "(photo)" in the session context and history DB (src/agent/runner.ts).
    content = name ? `(file: ${name})` : '(file)';
  }
  if (typeof (event as webhook.MessageEvent).replyToken === 'string') {
    meta.reply_token = (event as webhook.MessageEvent).replyToken as string;
  }
  return { content, meta };
}

export type NormalizedLinePostback = { chatId: string; replyToken: string; data: string };

/**
 * Rewrite a normalized media message whose bytes never arrived.
 *
 * Without this the turn still reaches the agent carrying `(file: report.pdf)` and
 * `attachment_kind="document"` but NO `image_path`, which is indistinguishable
 * from a staged file the agent simply has not opened yet — so the agent either
 * stays silent or claims to have read something it never received. That is the
 * silent-drop shape issue #429 was about, reappearing for the failure path.
 *
 * `reason` is a fixed phrase chosen by the caller, never a raw error string: the
 * result lands in the `<channel>` element body, which `buildChannelXml` does not
 * escape, so an SDK error message could otherwise forge tag structure. The
 * attachment meta is left in place — the name is still useful context, and its
 * `image_path` is (correctly) absent.
 */
export function markMediaUnavailable(
  norm: NormalizedLineMessage,
  mediaType: 'image' | 'file',
  reason: string,
): void {
  delete norm.meta.image_path;
  const name = norm.meta.attachment_name;
  const label = mediaType === 'image' ? 'image' : name ? `file: ${name}` : 'file';
  norm.content = `(${label} — not available: ${reason})`;
}

/** Parse a `/cli` approve/deny postback payload, or null when it's not ours. */
export function parseCliPostback(data: string): { pairingId: string; deny: boolean } | null {
  try {
    const p = JSON.parse(data) as { action?: string; pairing_id?: string };
    if (p.action === 'cli_approve' || p.action === 'cli_deny') {
      return { pairingId: typeof p.pairing_id === 'string' ? p.pairing_id : '', deny: p.action === 'cli_deny' };
    }
  } catch {
    // not JSON / not ours
  }
  return null;
}

/**
 * Normalize a LINE postback event (the slow-LLM "Get answer" button tap) into
 * {chatId, replyToken, data}. Returns null for non-postback / non-user / tokenless
 * events. `normalizeLineEvent` still drops postbacks; this is handled separately.
 */
export function normalizeLinePostback(event: webhook.Event): NormalizedLinePostback | null {
  if (event.type !== 'postback') return null;
  const source = event.source;
  if (!source) return null;
  const pe = event as webhook.PostbackEvent;
  const data = pe.postback?.data ?? '';
  const replyToken = typeof pe.replyToken === 'string' ? pe.replyToken : '';
  if (!data || !replyToken) return null;

  let chatId: string;
  if (source.type === 'user') {
    if (!source.userId) return null;
    chatId = source.userId;
  } else if (source.type === 'group') {
    if (!source.groupId) return null;
    chatId = source.groupId;
  } else if (source.type === 'room') {
    if (!source.roomId) return null;
    chatId = source.roomId;
  } else {
    return null;
  }

  return { chatId, replyToken, data };
}

/** Find the agent that has LINE configured (POC: single line-enabled agent, or by id). */
function resolveLineAgent(
  agents: Map<string, AgentRunner>,
  agentId?: string,
): AgentRunner | null {
  if (agentId) {
    const r = agents.get(agentId);
    return r && r.getAgentConfig().line?.channelSecret ? r : null;
  }
  for (const runner of agents.values()) {
    if (runner.getAgentConfig().line?.channelSecret) return runner;
  }
  return null;
}

/**
 * Optional outbound base-URL overrides — only used to point the LINE SDK at a
 * mock server in tests. Production passes nothing, so the SDK uses its real
 * defaults (api.line.me / api-data.line.me). Replaces the former
 * LINE_API_BASE / LINE_DATA_API_BASE env reads so there's no test-only env seam
 * leaking into production code.
 */
export interface LineWebhookOptions {
  apiBase?: string;
  dataApiBase?: string;
}

export function createLineWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: LineWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('line-webhook', logDir);

  // LINE webhook URL verification (Console "Verify" sends a GET / empty POST).
  const handleGet = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true });
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveLineAgent(agents, agentId);
    if (!runner) {
      res.status(404).json({ error: 'no LINE-enabled agent' });
      return;
    }
    const cfg = runner.getAgentConfig().line;
    const secret = cfg?.channelSecret ?? '';
    const signature = req.header('x-line-signature') ?? '';
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!secret || !signature || !validateSignature(buf, secret, signature)) {
      logger.warn('LINE webhook rejected: bad signature', { agentId: runner.getAgentConfig().id });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // Signature verified: derive our own public base URL and persist it for the
    // line_image MCP tool. Prefer the configured gateway.publicUrl host — it is
    // the trusted origin. Only when publicUrl is unset do we fall back to the
    // request host (X-Forwarded-Host / Host), which a client could spoof; that
    // fallback is still gated behind the channel-secret signature above.
    const configuredHost = hostFromPublicUrl(runner.getGatewayPublicUrl());
    const fwdHost = req.headers['x-forwarded-host'];
    const host =
      configuredHost ||
      (typeof fwdHost === 'string' ? fwdHost : Array.isArray(fwdHost) ? fwdHost[0] : '') ||
      req.headers.host ||
      '';
    persistPublicBase(runner.getAgentConfig().workspace, host, logger);

    // Acknowledge immediately; process events after responding.
    res.status(200).json({ ok: true });

    let events: webhook.Event[] = [];
    try {
      events = (JSON.parse(buf.toString('utf8')) as { events?: webhook.Event[] }).events ?? [];
    } catch (err) {
      logger.warn('LINE webhook: bad JSON', { error: (err as Error).message });
      return;
    }

    const token = cfg?.channelAccessToken ?? '';
    const client = token
      ? new messagingApi.MessagingApiClient({
          channelAccessToken: token,
          ...(opts.apiBase ? { baseURL: opts.apiBase } : {}),
        })
      : null;
    // Blob/data API lives on a different host (api-data.line.me) than the
    // messaging API, so it takes its own base override (used by tests).
    const blobClient = token
      ? new messagingApi.MessagingApiBlobClient({
          channelAccessToken: token,
          ...(opts.dataApiBase ? { baseURL: opts.dataApiBase } : {}),
        })
      : null;

    for (const event of events) {
      // Postback BEFORE access gate: a tap on our slow-LLM button must reach the
      // cache even if the user's allowlist status changed since the button was sent.
      // The postback data is opaque (request_id we issued), so bypassing the gate here
      // is safe — only users who received the button can tap it.
      const pb = normalizeLinePostback(event);
      if (pb) {
        // `/cli` approve/deny — unlock (or reject) a terminal-viewer pairing.
        // The pairing binds the requesting user; approveCliPairing checks the
        // tapping user (pb.chatId, a LINE-verified id) matches, so bypassing the
        // access gate here is safe — same as the slow-LLM postback below.
        const cli = parseCliPostback(pb.data);
        if (cli) {
          const result = runner.approveCliPairing('line', cli.pairingId, pb.chatId, cli.deny);
          if (client && pb.replyToken) {
            const text = cli.deny
              ? 'Denied.'
              : result === 'ok'
                ? 'Approved — return to the browser.'
                : 'Could not approve (the link may have expired). Send /cli again.';
            await client
              .replyMessage({ replyToken: pb.replyToken, messages: [{ type: 'text', text }] })
              .catch(() => {});
          }
          continue;
        }
        try {
          await runner.handleLinePostback(pb.chatId, pb.replyToken, pb.data);
        } catch (err) {
          logger.error('LINE webhook: postback handling failed', {
            error: (err as Error).message,
          });
        }
        continue;
      }

      // Access gate (single choke point — mirrors hermes _dispatch_event):
      // resolve the source once and gate before any message handling.
      // Closed by default for both DMs (dmPolicy/dmAllowlist) and groups/rooms
      // (groupPolicy/groupAllowlist). `'open'` restores answer-to-anyone.
      const resolved = resolveLineSource(event.source);
      if (!isResolvedSourceAllowed(cfg, resolved)) {
        logger.debug('LINE webhook: source not allowed', {
          agentId: runner.getAgentConfig().id,
          kind: resolved.kind,
          policy:
            (resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy) ?? '(closed)',
          conversationId: resolved.conversationId,
        });
        // Remember the knock so an admin can find + add it from the UI without
        // grepping logs, and (pairing mode) reply a one-time code the admin can
        // visually match before +Add. The id we track is the sender (DM) or the
        // conversation (group/room). Names are backfilled best-effort without
        // bumping the knock count.
        const deniedAgentId = runner.getAgentConfig().id;
        const knockId =
          resolved.kind === 'user' ? resolved.senderId : resolved.conversationId;
        if (knockId) {
          // Pairing applies only under allowlist/closed-default (open never
          // denies; disabled is hard-off) and unless explicitly turned off.
          const sourcePolicy = resolved.kind === 'user' ? cfg?.dmPolicy : cfg?.groupPolicy;
          const isPairing =
            cfg?.pairing !== false && sourcePolicy !== 'open' && sourcePolicy !== 'disabled';
          const prev = getPendingSender('line', deniedAgentId, knockId);
          const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);

          let wasNew = false;
          if (resolved.kind === 'user') {
            wasNew = recordDeniedSender('line', deniedAgentId, knockId, undefined, Date.now(), code);
            if (client) {
              void client
                .getProfile(knockId)
                .then((p) => {
                  const e = getPendingSender('line', deniedAgentId, knockId);
                  if (e && p?.displayName && !e.displayName) e.displayName = p.displayName;
                })
                .catch(() => {});
            }
          } else if (resolved.kind === 'group') {
            wasNew = recordDeniedConversation('line', deniedAgentId, knockId, 'group', undefined, Date.now(), code);
            if (client) {
              void client
                .getGroupSummary(knockId)
                .then((s) => {
                  const e = getPendingSender('line', deniedAgentId, knockId);
                  if (e && s?.groupName && !e.displayName) e.displayName = s.groupName;
                })
                .catch(() => {});
            }
          } else if (resolved.kind === 'room') {
            wasNew = recordDeniedConversation('line', deniedAgentId, knockId, 'room', undefined, Date.now(), code);
          }

          // Send the pairing code exactly once — on first contact only — via the
          // free reply token (never push; don't spend quota on strangers).
          const replyToken = (event as webhook.MessageEvent).replyToken;
          if (isPairing && wasNew && code && client && typeof replyToken === 'string' && replyToken) {
            void client
              .replyMessage({
                replyToken,
                messages: [{ type: 'text', text: pairingMessage(code, resolved.kind) }],
              })
              .catch((err) =>
                logger.debug('LINE pairing code reply failed', { error: (err as Error).message }),
              );
          }
        }
        continue;
      }

      // Normalize the event into our /channel intake format.
      const norm = normalizeLineEvent(event, resolved);
      if (!norm) continue;
      const userId = norm.meta.chat_id;

      // `/cli` opens the live terminal viewer (DM only). Mint a pairing and reply
      // with an open-link + Approve/Deny buttons instead of forwarding to the
      // agent. Reached only after the access gate above authorized this source.
      if ((norm.content ?? '').trim().toLowerCase() === '/cli') {
        if (norm.meta['line_chat_type'] === 'user' && client) {
          const replyToken = norm.meta['reply_token'] ?? '';
          const pairing = runner.createCliPairing('line', userId);
          if (replyToken) {
            const messages: messagingApi.Message[] = pairing
              ? [{
                  type: 'template',
                  altText: 'Live terminal viewer',
                  template: {
                    type: 'buttons',
                    text: `Live terminal viewer\nCode ${pairing.code} — open, confirm the code, then Approve.`,
                    actions: [
                      { type: 'uri', label: 'Open terminal', uri: pairing.url },
                      { type: 'postback', label: `Approve ${pairing.code}`, data: JSON.stringify({ action: 'cli_approve', pairing_id: pairing.pairingId }), displayText: 'Approve terminal viewer' },
                      { type: 'postback', label: 'Deny', data: JSON.stringify({ action: 'cli_deny', pairing_id: pairing.pairingId }) },
                    ],
                  },
                }]
              : [{ type: 'text', text: 'Terminal viewer is not configured. Set gateway.publicUrl in config.json first.' }];
            await client.replyMessage({ replyToken, messages }).catch((err) => {
              logger.debug('LINE /cli reply failed', { error: (err as Error).message });
            });
          }
        }
        continue;
      }

      // Group/room activation gate: unless requireMention is explicitly false,
      // only respond when the bot is @mentioned (native isSelf or its name).
      // DMs (line_chat_type === 'user') always pass. This runs after normalize
      // so unhandled message types are already filtered out.
      //
      // NOTE: LINE attaches `mention` to TEXT messages only, so an image or file
      // posted in a group can never satisfy this gate — such media reaches the
      // agent in DMs, and in groups only when requireMention is false. That is
      // the pre-existing behaviour for images and is left unchanged for files:
      // waiving the gate for media would let any group member push attachments
      // at the agent without ever addressing it.
      if (norm.meta.line_chat_type !== 'user' && cfg?.requireMention !== false) {
        const msg = (event as webhook.MessageEvent).message;
        if (!wasBotMentioned(msg as unknown as LineMessageLike)) {
          logger.debug('LINE webhook: group/room message without bot mention, ignoring', {
            agentId: runner.getAgentConfig().id,
            chatType: norm.meta.line_chat_type,
            conversationId: userId,
          });
          continue;
        }
      }

      // Inbound media: fetch the bytes via the blob API and hand the agent an
      // absolute path (meta.image_path). The runner persists it to MediaStore
      // and instructs the agent to Read it, same as Telegram attachments.
      // Images and files share that path; meta.media_type tells them apart.
      const mediaType = norm.meta.media_type;
      if ((mediaType === 'image' || mediaType === 'file') && blobClient && norm.meta.message_id) {
        try {
          let mediaPath: string | null;
          if (mediaType === 'image') {
            mediaPath = await downloadLineImage(blobClient, norm.meta.message_id);
          } else {
            // The extension comes from the RAW event name (safeFileExt sanitises
            // it itself) — meta.attachment_name is the display label and has
            // already had characters stripped, which could corrupt the suffix.
            const file = (event as webhook.MessageEvent).message as webhook.FileMessageContent;
            mediaPath = await downloadLineFile(blobClient, norm.meta.message_id, file.fileName, file.fileSize);
          }
          // A null path means the blob API answered with zero bytes. Both that and
          // a throw leave the agent with no file, so both must say so — see
          // markMediaUnavailable.
          if (mediaPath) {
            norm.meta.image_path = mediaPath;
            // Staging copy under os.tmpdir(): the runner owns it from here and
            // deletes it once MediaStore has its permanent copy. Nothing else
            // sweeps the temp dir, so without this every inbound attachment —
            // up to MediaStore.maxUploadBytes each — stays on disk forever.
            norm.meta.media_ephemeral = '1';
          } else markMediaUnavailable(norm, mediaType, 'the sender uploaded no content');
        } catch (err) {
          logger.warn('LINE webhook: media download failed', {
            mediaType,
            messageId: norm.meta.message_id,
            error: (err as Error).message,
          });
          markMediaUnavailable(
            norm,
            mediaType,
            err instanceof MediaTooLargeError
              ? `larger than the ${Math.floor(MAX_MEDIA_BYTES / (1024 * 1024))} MB limit`
              : 'the download failed',
          );
        }
      }

      // Loading animation (best-effort, 1:1 only — LINE rejects it for
      // groups/rooms, where chat_id is a groupId/roomId).
      if (client && norm.meta.line_chat_type === 'user') {
        client
          .showLoadingAnimation({ chatId: userId, loadingSeconds: LOADING_SECONDS })
          .catch((err) => logger.debug('showLoadingAnimation failed', { error: (err as Error).message }));
      }

      // Forward to the agent's existing /channel intake (same path Telegram uses).
      try {
        await fetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(norm),
        });
      } catch (err) {
        logger.error('LINE webhook: failed to forward to callback', {
          error: (err as Error).message,
        });
      }
    }
  };

  return { verify: handleGet, handlePost };
}
