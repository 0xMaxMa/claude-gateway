/**
 * mock-line-webhook.ts — simulate "a LINE user said X" against a running gateway,
 * without the LINE app or a tunnel. Builds a valid webhook payload, signs it with
 * the channel secret (x-line-signature), and POSTs it to the gateway route.
 *
 * Usage:
 *   LINE_CHANNEL_SECRET=... bun scripts/mock-line-webhook.ts "สวัสดี"
 *
 * Env overrides:
 *   LINE_CHANNEL_SECRET   (required) the agent's channel secret used to sign
 *   LINE_WEBHOOK_URL      target route (default http://localhost:3021/line/webhook)
 *   LINE_MOCK_USER_ID     sender userId (default Umock00000000000000000000000000)
 */
import { createHmac } from 'node:crypto';

const text = process.argv.slice(2).join(' ') || 'hello from mock-line-webhook';
const secret = process.env.LINE_CHANNEL_SECRET ?? '';
const url = process.env.LINE_WEBHOOK_URL ?? 'http://localhost:3021/line/webhook';
const userId = process.env.LINE_MOCK_USER_ID ?? 'Umock00000000000000000000000000';

if (!secret) {
  console.error('error: set LINE_CHANNEL_SECRET to the agent channel secret');
  process.exit(1);
}

const body = JSON.stringify({
  destination: 'mock',
  events: [
    {
      type: 'message',
      timestamp: Date.now(),
      replyToken: `mock-reply-${Date.now()}`,
      source: { type: 'user', userId },
      message: { type: 'text', id: `mock-${Date.now()}`, text },
    },
  ],
});

const signature = createHmac('sha256', secret).update(body).digest('base64');

async function main(): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-line-signature': signature },
    body,
  });
  console.log(`POST ${url}`);
  console.log(`→ ${res.status} ${res.statusText}`);
  console.log(`  user=${userId} text=${JSON.stringify(text)}`);
  if (res.status !== 200) {
    console.error('  (non-200 — check the channel secret matches the agent config)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('mock-line-webhook failed:', err);
  process.exit(1);
});
