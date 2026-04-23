#!/usr/bin/env bun
/**
 * Standalone Discord receiver — spawned by DiscordReceiver in src/discord/receiver.ts.
 * Connects to Discord, runs the access gate, and POSTs inbound messages to
 * CLAUDE_CHANNEL_CALLBACK so the AgentRunner can route them to a session.
 */

import { DiscordModule } from './module';
import type { InboundMessage } from '../../types';

const CALLBACK_URL = process.env.CLAUDE_CHANNEL_CALLBACK;
if (!CALLBACK_URL) {
  process.stderr.write('discord receiver: CLAUDE_CHANNEL_CALLBACK required\n');
  process.exit(1);
}

async function postCallback(inbound: InboundMessage): Promise<void> {
  const meta: Record<string, string> = {
    source: 'discord',
    chat_id: inbound.chatId,
    user: inbound.senderId,
    message_id: inbound.messageId ?? '',
    ts: new Date(inbound.ts).toISOString(),
  };

  if (inbound.attachmentFileId) {
    meta['attachment_file_id'] = inbound.attachmentFileId;
    if (inbound.attachmentSize != null) {
      meta['attachment_size'] = String(inbound.attachmentSize);
    }
  }

  try {
    await fetch(CALLBACK_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: inbound.text ?? '', meta }),
    });
  } catch (err) {
    process.stderr.write(`discord receiver: callback POST failed: ${err}\n`);
  }
}

const mod = new DiscordModule();
const controller = new AbortController();

function shutdown(): void {
  process.stderr.write('discord receiver: shutting down\n');
  controller.abort();
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.stderr.write('discord receiver: starting\n');
try {
  await mod.start(postCallback, controller.signal);
} catch (err) {
  process.stderr.write(`discord receiver: fatal error: ${err}\n`);
  process.exit(1);
}
