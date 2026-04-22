#!/usr/bin/env bun
/**
 * Gateway restart worker — runs as a detached process.
 * Kills all gateway processes, rebuilds, starts a new instance,
 * and notifies the originating channel (Telegram or Discord).
 *
 * Required env vars:
 *   GATEWAY_ROOT              — absolute path to project root
 *   RESTART_ORIGIN_CHANNEL    — "telegram" | "discord"
 *   RESTART_NOTIFY_TARGET_ID  — chat_id (Telegram) or channel_id (Discord)
 *   RESTART_NOTIFY_BOT_TOKEN  — bot token for the originating channel
 */

import { execSync, spawn } from 'child_process';
import * as path from 'path';

const GATEWAY_ROOT = process.env.GATEWAY_ROOT ?? path.resolve(__dirname, '..', '..', '..');
const ORIGIN_CHANNEL = process.env.RESTART_ORIGIN_CHANNEL ?? '';
const NOTIFY_TARGET = process.env.RESTART_NOTIFY_TARGET_ID ?? '';
const NOTIFY_TOKEN = process.env.RESTART_NOTIFY_BOT_TOKEN ?? '';

async function notify(text: string): Promise<void> {
  if (!NOTIFY_TARGET || !NOTIFY_TOKEN) return;

  try {
    if (ORIGIN_CHANNEL === 'telegram') {
      await fetch(`https://api.telegram.org/bot${NOTIFY_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: NOTIFY_TARGET, text }),
      });
    } else if (ORIGIN_CHANNEL === 'discord') {
      await fetch(`https://discord.com/api/v10/channels/${NOTIFY_TARGET}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${NOTIFY_TOKEN}`,
        },
        body: JSON.stringify({ content: text }),
      });
    }
  } catch {
    // Best-effort — do not crash worker on notification failure
  }
}

function killProcesses(): void {
  const patterns = [
    'node.*dist/index.js',
    'bun.*claude-gateway',
    'bun.*telegram/server',
    'bun.*plugins',
  ];
  for (const pat of patterns) {
    try {
      execSync(`pkill -9 -f "${pat}" 2>/dev/null || true`, { stdio: 'ignore' });
    } catch {
      // Ignore — process may not exist
    }
  }
}

async function waitDead(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execSync(
        'pgrep -f "node.*dist/index.js" 2>/dev/null; pgrep -f "bun.*claude-gateway" 2>/dev/null; true',
        { stdio: 'pipe' },
      );
    } catch {
      // pgrep exits 1 when nothing found — we're done
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function build(): void {
  execSync('npm run build', { cwd: GATEWAY_ROOT, stdio: 'inherit' });
}

function startGateway(): number {
  const child = spawn('node', ['--env-file-if-exists=.env', 'dist/index.js'], {
    cwd: GATEWAY_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid!;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  await notify('🔄 Gateway restarting...');

  killProcesses();
  await waitDead();

  try {
    build();
  } catch (err) {
    await notify(`❌ Restart failed at build step: ${err}`);
    process.exit(1);
  }

  const pid = startGateway();

  // Brief health window — if the process is still alive after 5s, assume success
  await sleep(5_000);

  try {
    execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    await notify(`✅ Gateway restarted (PID ${pid})`);
  } catch {
    await notify('❌ Gateway failed to start after restart');
    process.exit(1);
  }
}

main();
