/**
 * Shared pairing primitives for both scripts/create-agent.ts and mcp/tools/agent/handlers.ts.
 * Uses fetch (available in Node 18+ and Bun) — no https module dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramFirstDM {
  senderId: string;
  chatId: string;
  /** getUpdates offset to use for the next poll call */
  nextOffset: number;
}

export interface DiscordFirstDM {
  senderId: string;
  channelId: string;
}

interface TgUpdate {
  update_id: number;
  message?: {
    from: { id: number };
    chat: { id: number; type: string };
    text?: string;
  };
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

/**
 * Long-poll Telegram getUpdates until the first private DM arrives.
 * Returns sender/chat IDs plus the next polling offset.
 */
export async function pollForFirstTelegramDM(
  token: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<TelegramFirstDM> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const pollSecs = Math.min(30, Math.ceil(remaining / 1000));
    if (pollSecs === 0) break;

    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${pollSecs}&allowed_updates=%5B%22message%22%5D`;
      const res = await fetch(url);
      const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message?.chat.type === 'private') {
            return {
              senderId: String(update.message.from.id),
              chatId: String(update.message.chat.id),
              nextOffset: offset,
            };
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw new Error('Timed out waiting for first Telegram DM');
}

/**
 * Poll getUpdates until the user in chatId replies with the expected code.
 * Returns true if confirmed, false on timeout.
 */
export async function pollForTelegramCode(
  token: string,
  chatId: string,
  expectedCode: string,
  offset: number,
  timeoutMs = 3 * 60 * 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let currentOffset = offset;

  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const pollSecs = Math.min(30, Math.ceil(remaining / 1000));
    if (pollSecs === 0) break;

    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${currentOffset}&timeout=${pollSecs}&allowed_updates=%5B%22message%22%5D`;
      const res = await fetch(url);
      const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          currentOffset = update.update_id + 1;
          if (
            update.message?.chat.type === 'private' &&
            String(update.message.chat.id) === chatId &&
            update.message.text?.trim().toLowerCase() === expectedCode
          ) {
            return true;
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return false;
}

/** Send a message to a Telegram chat. Errors are swallowed (non-fatal). */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Not fatal
  }
}

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

/**
 * Connect to the Discord gateway via WebSocket and wait for the first DM.
 * Returns sender and channel IDs.
 */
export async function pollForFirstDiscordDM(
  token: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<DiscordFirstDM> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS = (globalThis as any).WebSocket as typeof WebSocket;
  return new Promise((resolve, reject) => {
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    const ws = new WS('wss://gateway.discord.gg/?v=10&encoding=json');

    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error('Pairing timeout — no Discord DM received within the allowed time'));
    }, timeoutMs);

    ws.onmessage = (event: MessageEvent) => {
      const payload = JSON.parse(event.data as string) as {
        op: number;
        d: Record<string, unknown>;
        t?: string;
      };
      const { op, d, t } = payload;

      if (op === 10) {
        const interval = (d.heartbeat_interval as number) ?? 41250;
        heartbeatTimer = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), interval);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: 4096 + 32768, // DIRECT_MESSAGES + MESSAGE_CONTENT
              properties: { os: 'linux', browser: 'claude-gateway', device: 'claude-gateway' },
            },
          }),
        );
      } else if (op === 0 && t === 'MESSAGE_CREATE') {
        const msg = d as Record<string, unknown>;
        const author = msg['author'] as Record<string, unknown> | undefined;
        if (!msg['guild_id'] && !author?.['bot']) {
          if (!resolved) {
            resolved = true;
            clearTimeout(deadline);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            ws.close();
            resolve({
              senderId: String(author?.['id'] ?? ''),
              channelId: String(msg['channel_id']),
            });
          }
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(deadline);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(new Error('Discord WebSocket error during pairing'));
    };
  });
}

/** Send a message to a Discord channel. Errors are swallowed (non-fatal). */
export async function sendDiscordMessage(
  token: string,
  channelId: string,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
    });
  } catch {
    // Not fatal
  }
}

// ---------------------------------------------------------------------------
// Access.json writers
// ---------------------------------------------------------------------------

export function writeTelegramAccess(stateDir: string, senderId: string): void {
  fs.writeFileSync(
    path.join(stateDir, 'access.json'),
    JSON.stringify(
      { dmPolicy: 'allowlist', allowFrom: [senderId], groups: {}, pending: {} },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export function writeDiscordAccess(stateDir: string, senderId: string): void {
  fs.writeFileSync(
    path.join(stateDir, 'access.json'),
    JSON.stringify(
      {
        dmPolicy: 'allowlist',
        allowFrom: [senderId],
        guildAllowlist: [],
        channelAllowlist: [],
        roleAllowlist: [],
        pending: {},
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// High-level non-interactive pairing (for MCP — no terminal readline)
// ---------------------------------------------------------------------------

/**
 * Full non-interactive Telegram pairing:
 * 1. Wait for first DM → 2. Send code → 3. Wait for user to reply with code → 4. Write access.json
 */
export async function pairTelegramUser(
  token: string,
  stateDir: string,
  timeoutMs = 8 * 60 * 1000,
): Promise<{ chatId: string }> {
  const { senderId, chatId, nextOffset } = await pollForFirstTelegramDM(token, timeoutMs);

  const code = randomBytes(3).toString('hex');
  await sendTelegramMessage(
    token,
    chatId,
    `Pairing code: ${code}\n\nReply with this code to complete pairing.`,
  );

  const confirmed = await pollForTelegramCode(token, chatId, code, nextOffset, 3 * 60 * 1000);
  if (!confirmed) {
    throw new Error('Pairing timed out — user did not reply with the pairing code within 3 minutes');
  }

  writeTelegramAccess(stateDir, senderId);
  await sendTelegramMessage(token, chatId, "You're connected! Send me a message to get started.");

  return { chatId };
}

/**
 * Full non-interactive Discord pairing:
 * 1. Wait for first DM → 2. Send code → 3. Auto-approve (no HTTP polling for Discord code reply) → 4. Write access.json
 *
 * Discord does not support HTTP-based message polling, so code confirmation is skipped;
 * the first DM sender is trusted as the owner.
 */
export async function pairDiscordUser(
  token: string,
  stateDir: string,
  timeoutMs = 8 * 60 * 1000,
): Promise<{ channelId: string }> {
  const { senderId, channelId } = await pollForFirstDiscordDM(token, timeoutMs);

  const code = randomBytes(3).toString('hex');
  await sendDiscordMessage(
    token,
    channelId,
    `Pairing code: ${code}\n\nYou have been automatically paired as the bot owner.`,
  );

  writeDiscordAccess(stateDir, senderId);
  await sendDiscordMessage(token, channelId, "You're connected! Send me a message to get started.");

  return { channelId };
}
