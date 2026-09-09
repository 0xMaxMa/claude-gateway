/**
 * HTTP client for Tencent's iLink Bot API — the unofficial bridge both
 * source projects this channel was researched from (Hermes-agent's Weixin
 * adapter, OpenClaw's WeChat plugin) use to automate a personal WeChat
 * account. See the approved cross-repo plan for the full research summary.
 *
 * IMPORTANT — endpoint paths below are provisional. Neither source doc
 * publishes a full API reference (both only describe behavior: QR login,
 * `getupdates` long-polling with a 35s timeout, a 4000-char message limit
 * with a 0.3s inter-chunk delay, AES-128-ECB media encryption before CDN
 * upload, and an echoed `context_token` per recipient). The exact request/
 * response shapes here MUST be verified and corrected against iLink's own
 * documentation once GetPod actually has an account — this is the one part
 * of this channel that cannot be finished from the source docs alone (see
 * the "Prerequisite that blocks all engineering work" section of the plan).
 *
 * Everything that consumes this client (`WeChatManager`) depends only on
 * the `ILinkClient` interface, so tests inject a mock and never need real
 * credentials — only this file needs revisiting once the real API is in hand.
 */

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
   * Send a single already-chunked text message. `contextToken` is the value
   * iLink previously handed back for this recipient (undefined on the first
   * message to them); the resolved value must be echoed on the next call.
   */
  sendText(
    creds: ILinkCredentials,
    toId: string,
    text: string,
    contextToken?: string,
  ): Promise<{ contextToken: string }>;
}

/**
 * Real implementation — talks to iLink's actual HTTP API. Endpoint paths are
 * provisional (see module doc comment above); every method throws until
 * corrected against iLink's real documentation.
 */
export function createILinkClient(_baseUrl: string): ILinkClient {
  const notImplemented = (method: string): never => {
    throw new Error(
      `ILinkClient.${method}: not implemented — iLink's real API contract must be filled in ` +
        'once GetPod has an iLink account (see wechat/ilink-client.ts module doc comment).',
    );
  };
  return {
    requestLinkQr: () => Promise.reject(notImplemented('requestLinkQr')),
    pollLinkStatus: () => Promise.reject(notImplemented('pollLinkStatus')),
    getUpdates: () => Promise.reject(notImplemented('getUpdates')),
    sendText: () => Promise.reject(notImplemented('sendText')),
  };
}
