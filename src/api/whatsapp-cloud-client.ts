/**
 * Thin WhatsApp Business Cloud API (Meta Graph API) wrapper — the outbound
 * half of the WhatsApp Cloud channel.
 *
 * Modeled on `slack-client.ts`'s shape (Bearer auth, thin fetch wrappers, a
 * `{accessToken, phoneNumberId, logDir, apiBase?}` constructor) but the
 * request body is plain JSON, not form-urlencoded — Slack's form-encoding
 * was a Slack-specific finding (see slack-client.ts's `call()` doc comment),
 * not a universal REST-API rule. The Graph API accepts and expects JSON.
 *
 * Phase 2 of the WhatsApp feature-parity plan added the ack/read-receipt half
 * that v1 deliberately skipped (`markAsRead`, `sendReaction`,
 * `removeReaction`) — ported from `slack-client.ts`'s addReaction/
 * removeReaction shape, same best-effort posture (log, never throw).
 *
 * Phase 3 adds the two Cloud-ONLY message kinds that have no Baileys analogue
 * at all (`sendInteractiveButtons`/`sendInteractiveList`) and the 24h-window
 * escape hatch (`sendTemplate`). These are net-new here — no other channel in
 * this gateway sends interactive blocks, so there was no in-repo pattern to
 * port; the payload shapes come straight from Meta's Cloud API reference.
 */
import * as fs from 'fs';
import { createLogger } from '../logger';
import { chunkText } from '../shared/text-chunk';
import { WHATSAPP_ACK_EMOJI } from '../shared/whatsapp-ack';

const WHATSAPP_CLOUD_API_BASE = 'https://graph.facebook.com/v20.0';

/**
 * Cloud API hard limit for a text message body. Longer replies are split
 * across several messages rather than being rejected by Meta (error 131009)
 * or silently truncated.
 */
export const WHATSAPP_CLOUD_MAX_TEXT_CHARS = 4096;

/**
 * Meta's hard cap on reply buttons in an `interactive: {type: 'button'}`
 * message. Not a soft/UX limit — the Graph API rejects a 4th button outright,
 * so `sendInteractiveButtons` refuses locally with a readable message rather
 * than letting the agent see an opaque Meta error code.
 */
export const WHATSAPP_CLOUD_MAX_BUTTONS = 3;

/** A single reply button: `id` is what comes back on tap, `title` is what the user sees. */
export interface WhatsAppCloudButton {
  id: string;
  title: string;
}

/** One row of a list message. `description` is the optional grey sub-line. */
export interface WhatsAppCloudListRow {
  id: string;
  title: string;
  description?: string;
}

/** A list message's section — a titled group of rows. */
export interface WhatsAppCloudListSection {
  title: string;
  rows: WhatsAppCloudListRow[];
}

// Re-exported so `mcp/tools/whatsapp-cloud/module.ts` — which may only import
// the compiled dist/ artifact of THIS file, never src/ directly — can reach
// the shared ack emoji without a second import path.
export { WHATSAPP_ACK_EMOJI };

export interface WhatsAppCloudClientOptions {
  accessToken: string;
  phoneNumberId: string;
  logDir: string;
  /** Test-only override for the Graph API base URL. Production uses the real default. */
  apiBase?: string;
}

export interface WhatsAppCloudApiResponse {
  error?: { message?: string; type?: string; code?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export class WhatsAppCloudClient {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiBase: string;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(opts: WhatsAppCloudClientOptions) {
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.apiBase = opts.apiBase ?? WHATSAPP_CLOUD_API_BASE;
    this.logger = createLogger('whatsapp-cloud-client', opts.logDir);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<WhatsAppCloudApiResponse> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as WhatsAppCloudApiResponse;
    if (json.error) {
      this.logger.warn(`WhatsApp Cloud API ${method} ${path} failed`, { error: json.error });
    }
    return json;
  }

  /**
   * Verify the token + phone number id — used both as the connect flow's
   * "Save"-time check (router.ts) and reused here for any other caller that
   * wants a live credential check without duplicating the request shape.
   */
  async verifyCredentials(): Promise<{ ok: boolean; error?: string }> {
    const json = await this.call('GET', `/${this.phoneNumberId}`);
    if (json.error) {
      return { ok: false, error: json.error.message ?? 'unknown error' };
    }
    return { ok: true };
  }

  /**
   * Send a plain text message, splitting anything over the Cloud API's
   * 4096-char body limit into several messages (one Graph API call per chunk,
   * sent in order).
   *
   * `quotedMessageId` makes the FIRST chunk a quote-reply to that inbound
   * message (Meta's outbound `context: {message_id}`); follow-on chunks are
   * plain so the conversation doesn't show the same quote block repeated.
   *
   * Returns the first errored response if any chunk failed (so existing
   * `if (sent.error)` callers still see the failure), otherwise the last
   * successful one.
   */
  async sendText(
    to: string,
    body: string,
    quotedMessageId?: string,
  ): Promise<WhatsAppCloudApiResponse> {
    const chunks = chunkText(body, WHATSAPP_CLOUD_MAX_TEXT_CHARS);
    // chunkText returns [] for an empty body — keep the historical single-call
    // behaviour so a caller that deliberately sends "" still hits the API.
    const parts = chunks.length > 0 ? chunks : [body];
    let last: WhatsAppCloudApiResponse = {};
    for (let i = 0; i < parts.length; i++) {
      last = await this.call('POST', `/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: parts[i]! },
        ...(i === 0 && quotedMessageId ? { context: { message_id: quotedMessageId } } : {}),
      });
      if (last.error) return last;
    }
    return last;
  }

  /**
   * Send up to 3 tappable reply buttons under a body of text (Phase 3).
   *
   * A tap comes back through the webhook as `type: 'interactive'` with a
   * `button_reply` — the inbound normalizer turns that into plain text
   * (the button's title), so the agent reads a tap exactly as if the user had
   * typed the label. See normalizeWhatsAppCloudMessage's interactive branch.
   *
   * THROWS (rather than returning an `{error}` response) when more than
   * WHATSAPP_CLOUD_MAX_BUTTONS are passed or the list is empty: both are
   * caller bugs that Meta would reject anyway, and a thrown, readable message
   * reaches the agent through the MCP tool's catch as actionable text.
   */
  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: WhatsAppCloudButton[],
  ): Promise<WhatsAppCloudApiResponse> {
    if (buttons.length === 0) {
      throw new Error('sendInteractiveButtons: at least 1 button is required');
    }
    if (buttons.length > WHATSAPP_CLOUD_MAX_BUTTONS) {
      throw new Error(
        `sendInteractiveButtons: WhatsApp allows at most ${WHATSAPP_CLOUD_MAX_BUTTONS} buttons, got ${buttons.length}. ` +
          'Use a list message (sendInteractiveList) for more options.',
      );
    }
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    });
  }

  /**
   * Send a list message — a single button that opens a picker of grouped rows
   * (Phase 3). The way past the 3-button ceiling above.
   *
   * A pick comes back as `type: 'interactive'` with a `list_reply`, handled by
   * the same normalizer branch as button taps.
   */
  async sendInteractiveList(
    to: string,
    bodyText: string,
    buttonLabel: string,
    sections: WhatsAppCloudListSection[],
  ): Promise<WhatsAppCloudApiResponse> {
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonLabel, sections },
      },
    });
  }

  /**
   * Send a pre-approved message template (Phase 3) — the ONLY way to open a
   * conversation outside WhatsApp's 24h customer-service window, which is why
   * the caller must be gated on `whatsapp_cloud.templatesEnabled` (see
   * mcp/tools/whatsapp-cloud/module.ts; this method itself does not gate).
   *
   * `components` is Meta's variable-substitution array. It is passed through
   * VERBATIM and deliberately NOT validated or typed beyond `unknown[]`: its
   * required shape depends on the individual template's definition in Meta's
   * Business Manager, which this gateway has no visibility into.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<WhatsAppCloudApiResponse> {
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
  }

  /**
   * Mark an inbound message as read (the blue double-tick on the sender's
   * side). Best-effort: logged, never thrown — a read receipt is UX polish,
   * not correctness-critical, exactly like Slack's ack reaction.
   */
  async markAsRead(messageId: string): Promise<void> {
    const json = await this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
    if (json.error) {
      this.logger.debug('markAsRead failed', { error: json.error });
    }
  }

  /**
   * Ack-reaction (ported from `slack-client.ts`'s addReaction): added to the
   * inbound message on receipt, cleared once the agent's reply lands. An
   * EMPTY `emoji` is how the Cloud API removes an existing reaction — see
   * removeReaction below. Best-effort, same as markAsRead.
   */
  async sendReaction(to: string, messageId: string, emoji = WHATSAPP_ACK_EMOJI): Promise<void> {
    const json = await this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    });
    if (json.error) {
      this.logger.debug('sendReaction failed', { error: json.error });
    }
  }

  /** Clear a reaction — the same endpoint with an empty-string emoji. */
  async removeReaction(to: string, messageId: string): Promise<void> {
    return this.sendReaction(to, messageId, '');
  }

  /**
   * Upload a local file to the Cloud API's media store, returning its
   * `media_id` — a prerequisite step before `sendImage`/`sendDocument`
   * (the Cloud API sends media by id, not by raw bytes or URL, for
   * gateway-originated files).
   */
  async uploadMedia(filePath: string, mimeType: string): Promise<{ mediaId: string } | { error: string }> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([new Uint8Array(fs.readFileSync(filePath))], { type: mimeType }), filePath.split('/').pop());
    const res = await fetch(`${this.apiBase}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    const json = (await res.json()) as WhatsAppCloudApiResponse;
    if (json.error || typeof json.id !== 'string') {
      const error = json.error?.message ?? 'upload failed: no media id returned';
      this.logger.warn('WhatsApp Cloud media upload failed', { error });
      return { error };
    }
    return { mediaId: json.id };
  }

  /** Send an already-uploaded image by media id, with an optional caption. */
  async sendImage(to: string, mediaId: string, caption?: string): Promise<WhatsAppCloudApiResponse> {
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id: mediaId, ...(caption ? { caption } : {}) },
    });
  }

  /** Send an already-uploaded document by media id, with a filename and optional caption. */
  async sendDocument(to: string, mediaId: string, filename: string, caption?: string): Promise<WhatsAppCloudApiResponse> {
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
    });
  }
}
