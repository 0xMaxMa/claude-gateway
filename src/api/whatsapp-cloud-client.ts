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
 * No reaction/ack methods — deliberately dropped for v1 (the plan calls this
 * out explicitly): Slack's ack-reaction is a UX nicety this channel doesn't
 * try to replicate yet.
 */
import * as fs from 'fs';
import { createLogger } from '../logger';

const WHATSAPP_CLOUD_API_BASE = 'https://graph.facebook.com/v20.0';

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

  /** Send a plain text message. */
  async sendText(to: string, body: string): Promise<WhatsAppCloudApiResponse> {
    return this.call('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    });
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
