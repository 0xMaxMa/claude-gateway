/**
 * Discord outbound adapter — openclaw pattern from send.outbound.ts.
 * Uses local SendableChannel interface; no top-level discord.js import.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SendableChannel, SentMessage, EmbedData, FileAttachment } from './types';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_EMBED_DESCRIPTION = 4096;

export async function sendMessage(
  channel: SendableChannel,
  text: string,
  options: {
    replyTo?: string;
    files?: string[];
    useEmbed?: boolean;
  } = {},
): Promise<SentMessage[]> {
  const sent: SentMessage[] = [];

  if (text.length > MAX_MESSAGE_LENGTH && options.useEmbed) {
    const embedText = text.slice(0, MAX_EMBED_DESCRIPTION);
    const embed: EmbedData = { description: embedText };
    const msg = await channel.send({ embeds: [embed] });
    sent.push(msg);

    const remaining = text.slice(MAX_EMBED_DESCRIPTION);
    if (remaining) {
      const chunks = chunkText(remaining, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        sent.push(await channel.send({ content: chunk }));
      }
    }
  } else {
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    const replyRef = options.replyTo;
    for (let i = 0; i < chunks.length; i++) {
      const sendOpts: Parameters<SendableChannel['send']>[0] = { content: chunks[i] };
      if (replyRef && i === 0) sendOpts.reply = { messageReference: replyRef };
      sent.push(await channel.send(sendOpts));
    }
  }

  for (const filePath of options.files ?? []) {
    const attachment: FileAttachment = {
      attachment: filePath,
      name: path.basename(filePath),
    };
    sent.push(await channel.send({ files: [attachment] }));
  }

  return sent;
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const nl = rest.lastIndexOf('\n', limit);
    const sp = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : nl > limit / 2 ? nl : sp > 0 ? sp : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function validateFilePath(filePath: string, inboxDir: string): void {
  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return;
  }
  let inboxReal: string;
  try {
    inboxReal = fs.realpathSync(inboxDir);
  } catch {
    return;
  }
  if (real.startsWith(path.dirname(inboxReal) + path.sep) && !real.startsWith(inboxReal + path.sep)) {
    throw new Error(`refusing to send state directory file: ${filePath}`);
  }
}
