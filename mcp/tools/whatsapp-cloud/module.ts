/**
 * WhatsApp Business Cloud API outbound tool module — exposes
 * `whatsapp_cloud_reply` to the Claude session.
 *
 * WhatsApp Cloud is a ToolModule (reply-only, like Slack/LINE): inbound
 * arrives via the gateway's Express webhook route
 * (src/api/whatsapp-cloud-webhook-router.ts), not here.
 *
 * Mirrors `mcp/tools/slack/module.ts` directly — real, Meta-issued
 * credentials with no reply-token TTL to work around, so this module always
 * sends directly from the subprocess, same as Slack. The one Slack param it
 * still has no analogue for is `thread_id`: the Cloud API has no threads, only
 * per-message quoting (`reply_to_message_id`).
 *
 * Phase 3 adds three Cloud-only send modes on top of text/files: interactive
 * `buttons` and `list` (no other channel here has any interactive-block
 * support), and `template_name` — gated behind the agent's
 * `whatsapp_cloud.templatesEnabled` opt-in, forwarded here as
 * WHATSAPP_CLOUD_TEMPLATES_ENABLED, because a template is what reaches a user
 * OUTSIDE WhatsApp's 24h customer-service window.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
// mcp/ ships as source (package.json `files` lists "mcp/", not "src/") and
// runs directly under bun — it may only import a compiled dist/ artifact,
// never src/ directly (see tests/unit/mcp-no-src-imports.test.ts). `npm run
// build` must have run at least once for this import to resolve locally.
import { WhatsAppCloudClient } from '../../../dist/api/whatsapp-cloud-client.js';
// Same dist-only rule as the client import above. MediaStore is reached for
// its image size cap alone — the Baileys channel's outbound path already
// measures against that exact value, and a second literal here would drift.
import { MediaStore } from '../../../dist/history/media-store.js';
import { optimizeImageFile } from '../../../dist/shared/image-optimize.js';
import { MAX_ATTACHMENT_BYTES } from '../shared/limits';

/**
 * Extension-based mime sniff for outbound files — self-contained on purpose
 * (mirrors limits.ts's own doc comment: mcp/** must not import src/**, so
 * this can't reuse src/shared/image-sniff.ts's magic-byte sniffer). Good
 * enough here because these are files the AGENT itself wrote (generate_image
 * output, a downloaded PDF, ...), not attacker-controlled bytes — unlike the
 * inbound side, where the webhook router sniffs the real bytes.
 */
/** A reply button as the tool accepts it (mirrors the client's WhatsAppCloudButton). */
interface ReplyButton {
  id: string;
  title: string;
}

/**
 * Coerce the tool's `buttons` argument into well-formed buttons, dropping
 * anything without BOTH an id and a title (a half-specified button would
 * render blank or be rejected by Meta). Returns [] for a missing/non-array
 * argument, which the caller reads as "not an interactive send".
 */
function parseButtons(raw: unknown): ReplyButton[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyButton[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const { id, title } = b as { id?: unknown; title?: unknown };
    if (typeof id === 'string' && id && typeof title === 'string' && title) out.push({ id, title });
  }
  return out;
}

/**
 * Normalize `template_params` into Meta's `components` array.
 *
 * Two accepted shapes, because template definitions vary wildly and a small
 * model should not have to hand-build Meta's nested component JSON for the
 * overwhelmingly common case (a handful of {{1}}, {{2}} body variables):
 *
 *  - SIMPLE — an array of strings/numbers: ["Alice", "3pm"] becomes one body
 *    component with those values as positional text parameters, in order.
 *  - RAW — an array of objects: passed through VERBATIM as `components`, for
 *    templates with header/button components, named params, currency or
 *    date_time parameters, or anything else the simple form cannot express.
 *
 * A mixed array is treated as RAW (pass-through) — Meta will reject it with a
 * template-specific error, which is more useful than us guessing.
 */
export function buildTemplateComponents(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const allScalar = raw.every((p) => typeof p === 'string' || typeof p === 'number');
  if (!allScalar) return raw as unknown[];
  return [
    {
      type: 'body',
      parameters: raw.map((p) => ({ type: 'text', text: String(p) })),
    },
  ];
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export class WhatsAppCloudModule implements ToolModule {
  id = 'whatsapp_cloud';
  toolVisibility: ToolVisibility = 'current-channel';

  // Files already delivered this session — same retry-dedup as Slack's
  // module (a small model sometimes retries after a transient send hiccup
  // even though the upload landed, which would spam duplicate media).
  private readonly sentFiles = new Set<string>();

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'whatsapp_cloud';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'whatsapp_cloud_reply',
        description:
          'Send a reply to the current WhatsApp conversation (WhatsApp Business Cloud API). ' +
          'Pass chat_id (the phone number shown in the <channel> tag) and text. ' +
          'Optionally pass files (absolute paths) to attach images or PDF documents — ' +
          'each file is sent as its own message; a caption (from text) rides on the first one. ' +
          'Also pass message_id from the <channel> tag when present — it clears the ' +
          '⏳ "seen" reaction the gateway left on the inbound message. ' +
          'For a multiple-choice question, pass buttons (up to 3 tappable replies) or ' +
          'list (a picker, for more than 3 options) instead of writing the options into text — ' +
          "the user's tap arrives back as a normal message containing the option's title. " +
          'To message a user who has NOT written in the last 24 hours, a free-form reply is ' +
          'impossible: pass template_name + template_language for a pre-approved template ' +
          '(only works if the agent has WhatsApp templates enabled).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'WhatsApp phone number to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text.',
            },
            reply_to_message_id: {
              type: 'string',
              description:
                'Optional inbound message id to quote — the reply appears attached to that ' +
                'message in the conversation.',
            },
            message_id: {
              type: 'string',
              description:
                'Optional inbound message id from the <channel> tag — clears the ⏳ ack ' +
                'reaction the gateway left on it.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute file paths to attach (images or PDF documents). Optional — text can be ' +
                'sent alone, files can be sent alone, or both together (text becomes the first file\'s caption). ' +
                'An oversized image is downscaled automatically, so a large screenshot or chart does not ' +
                'need to be resized before calling this.',
            },
            buttons: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Machine-readable id returned when this button is tapped.' },
                  title: { type: 'string', description: 'Button label the user sees (keep it short — WhatsApp truncates).' },
                },
                required: ['id', 'title'],
              },
              description:
                'Optional: up to 3 tappable reply buttons shown under text (which becomes the question). ' +
                'WhatsApp allows no more than 3 — use `list` for more options. Cannot be combined with files.',
            },
            list: {
              type: 'object',
              properties: {
                button_label: {
                  type: 'string',
                  description: 'Label of the button that opens the picker (e.g. "Choose a slot").',
                },
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      rows: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            description: { type: 'string' },
                          },
                          required: ['id', 'title'],
                        },
                      },
                    },
                    required: ['title', 'rows'],
                  },
                },
              },
              required: ['button_label', 'sections'],
              description:
                'Optional: a list message — one button that opens a picker of grouped rows. ' +
                'Use when there are more than 3 options. `text` becomes the question above it.',
            },
            template_name: {
              type: 'string',
              description:
                'Optional: name of a pre-approved WhatsApp message template. Required to reach a user ' +
                'more than 24h after their last message (free-form text is rejected by WhatsApp then). ' +
                'Must be enabled for this agent, otherwise the send is refused.',
            },
            template_language: {
              type: 'string',
              description:
                'Language code of the template, e.g. "en_US" or "th". Required whenever template_name is given.',
            },
            template_params: {
              type: 'array',
              description:
                'Optional template variables. Simple form: an array of strings filling the template body\'s ' +
                '{{1}}, {{2}}, ... in order, e.g. ["Alice", "3pm"]. Advanced form: an array of raw Meta ' +
                '"components" objects, passed through untouched, for templates with header or button variables.',
            },
          },
          // `text` is NOT required: a files-only reply (an image with no caption)
          // is a legitimate send.
          required: ['chat_id'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'whatsapp_cloud_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const requested = Array.isArray(args.files) ? (args.files as unknown[]) : [];
    const replyTo =
      typeof args.reply_to_message_id === 'string' && args.reply_to_message_id
        ? args.reply_to_message_id
        : undefined;
    const messageId = typeof args.message_id === 'string' && args.message_id ? args.message_id : '';
    const accessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ?? '';
    const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? '';

    // Phase 3 send modes. An EMPTY buttons array counts as "not interactive"
    // (falls through to a plain text send) rather than an error — the model
    // sometimes emits `buttons: []` when it decided against offering choices.
    const buttons = parseButtons(args.buttons);
    const list = args.list && typeof args.list === 'object' ? (args.list as Record<string, unknown>) : undefined;
    const templateName =
      typeof args.template_name === 'string' && args.template_name ? args.template_name : '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'whatsapp_cloud_reply: missing chat_id' }], isError: true };
    }

    // Template gate (Phase 3). Refused loudly, never silently downgraded to a
    // plain text send: outside the 24h window that text would ALSO fail, and a
    // silent swap would hide the real reason from the agent. The opt-in lives
    // in agent config (whatsapp_cloud.templatesEnabled) and reaches this
    // subprocess as an env var — see session/process.ts.
    if (templateName && process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED !== '1') {
      return {
        content: [
          {
            type: 'text',
            text:
              'whatsapp_cloud_reply: message templates are not enabled for this agent. ' +
              'Enable whatsapp_cloud.templatesEnabled in the agent settings first (it is off by ' +
              'default because templates can reach users outside the 24h reply window). ' +
              'Within 24h of the user\'s last message, send plain text instead.',
          },
        ],
        isError: true,
      };
    }
    if (templateName && !(typeof args.template_language === 'string' && args.template_language)) {
      return {
        content: [
          {
            type: 'text',
            text: 'whatsapp_cloud_reply: template_language is required when template_name is given (e.g. "en_US").',
          },
        ],
        isError: true,
      };
    }

    // Drop files already delivered successfully this session (retry-dedup).
    const files = requested.filter(
      (f): f is string => typeof f === 'string' && !this.sentFiles.has(f),
    );

    // Nothing new to say or send — the whole reply is a duplicate retry. No-op
    // success so the agent treats it as delivered and stops retrying.
    // A template send carries its own content (the approved template body), so
    // it is exempt from both empty-text checks below.
    if (!text && files.length === 0 && !templateName && requested.length > 0) {
      return { content: [{ type: 'text', text: 'already sent (duplicate suppressed)' }] };
    }
    if (!text && files.length === 0 && !templateName) {
      return { content: [{ type: 'text', text: 'whatsapp_cloud_reply: text cannot be empty' }], isError: true };
    }
    if (!accessToken || !phoneNumberId) {
      return {
        content: [{ type: 'text', text: 'whatsapp_cloud_reply: missing WHATSAPP_CLOUD_ACCESS_TOKEN/WHATSAPP_CLOUD_PHONE_NUMBER_ID' }],
        isError: true,
      };
    }

    const client = new WhatsAppCloudClient({
      accessToken,
      phoneNumberId,
      logDir: process.env.GATEWAY_WORKSPACE_DIR ?? '/tmp',
    });

    try {
      // Size-check before any upload starts, so an oversized file fails fast
      // instead of half-way through a multi-file batch.
      for (const f of files) {
        const st = fs.statSync(f);
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
        }
      }

      // Send-mode precedence: template → buttons → list → files → plain text.
      // Template wins outright because it is the only mode that works outside
      // the 24h window; interactive modes come before files because the Cloud
      // API cannot attach buttons to a media message at all.
      if (templateName) {
        const sent = await client.sendTemplate(
          chatId,
          templateName,
          args.template_language as string,
          buildTemplateComponents(args.template_params),
        );
        if (sent.error) throw new Error(sent.error.message ?? 'send failed');
      } else if (buttons.length > 0) {
        // >3 buttons throws inside the client with a readable message, which
        // the catch below turns into an actionable tool error.
        const sent = await client.sendInteractiveButtons(chatId, text, buttons);
        if (sent.error) throw new Error(sent.error.message ?? 'send failed');
      } else if (list) {
        const buttonLabel = typeof list.button_label === 'string' ? list.button_label : '';
        const sections = Array.isArray(list.sections) ? list.sections : [];
        if (!buttonLabel || sections.length === 0) {
          throw new Error('list requires button_label and at least one section');
        }
        const sent = await client.sendInteractiveList(chatId, text, buttonLabel, sections);
        if (sent.error) throw new Error(sent.error.message ?? 'send failed');
      } else if (files.length > 0) {
        // The Cloud API sends one message per media item (no Slack-style
        // batch-into-one-message) — the caption rides on the FIRST file only.
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          const mime = guessMimeType(f);
          const isImage = mime.startsWith('image/');

          // Auto-optimize an over-cap PHOTO rather than letting Meta reject the
          // upload. Only on the image branch: the extension-based image-vs-
          // document decision below IS this channel's equivalent of Baileys'
          // asDocument flag (the Cloud API has no single force-document
          // toggle), and a document send must deliver its exact bytes.
          let uploadPath = f;
          let uploadMime = mime;
          if (isImage) {
            const size = fs.statSync(f).size;
            if (size > MediaStore.maxUploadBytes) {
              uploadPath = await optimizeImageFile(f, MediaStore.maxUploadBytes).catch(() => f);
              // optimizeImageFile always emits JPEG; keep the declared mime in
              // step with the bytes actually being uploaded.
              if (uploadPath !== f) uploadMime = 'image/jpeg';
            }
          }

          const uploaded = await client.uploadMedia(uploadPath, uploadMime);
          if ('error' in uploaded) {
            throw new Error(uploaded.error);
          }
          const caption = i === 0 ? (text || undefined) : undefined;
          const sent = isImage
            ? await client.sendImage(chatId, uploaded.mediaId, caption)
            : await client.sendDocument(chatId, uploaded.mediaId, path.basename(f), caption);
          if (sent.error) {
            throw new Error(sent.error.message ?? 'send failed');
          }
        }
      } else {
        const sent = await client.sendText(chatId, text, replyTo);
        if (sent.error) {
          throw new Error(sent.error.message ?? 'send failed');
        }
      }

      // Mark as sent only AFTER the send succeeds — a genuine failure leaves
      // them eligible for a retry rather than silently dropped. Only when the
      // FILE branch actually ran: a template/interactive send takes precedence
      // over any files passed alongside it, and those files were not delivered,
      // so marking them here would suppress a later, legitimate retry.
      const filesWereSent = !templateName && buttons.length === 0 && !list && files.length > 0;
      if (filesWereSent) for (const f of files) this.sentFiles.add(f);
      // Best-effort: clear the ack-reaction the webhook left on the inbound
      // message (mirrors slack_reply's removeReaction call site). Never blocks
      // or fails the reply itself. Skipped when the gateway has reactions
      // turned off for this channel, so nothing tries to clear a reaction that
      // was never added.
      if (messageId && (process.env.WHATSAPP_CLOUD_REACTION_LEVEL ?? 'ack') === 'ack') {
        void client.removeReaction(chatId, messageId).catch(() => {});
      }
      return {
        content: [
          {
            type: 'text',
            text: templateName
              ? `Sent WhatsApp template "${templateName}".`
              : buttons.length > 0
                ? `Sent message to WhatsApp (${buttons.length} button(s)).`
                : list
                  ? 'Sent message to WhatsApp (list).'
                  : filesWereSent
                    ? `Sent message to WhatsApp (${files.length} file(s)).`
                    : 'Sent message to WhatsApp.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `whatsapp_cloud_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
