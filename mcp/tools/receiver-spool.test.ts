import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiverSpool } from './receiver-spool';

test('receiver restart retains unacknowledged input and removes it only after gateway acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'receiver-spool-'));
  let fail = true;
  const delivered: unknown[] = [];
  const request = (async (_url: string | URL | Request, options?: RequestInit) => {
    delivered.push(JSON.parse(String(options?.body)));
    return new Response('', { status: fail ? 503 : 200 });
  }) as typeof fetch;
  let spool = new ReceiverSpool(root, 'http://fixture.invalid/channel', request);
  try {
    const input = { content: 'hello', meta: { chat_id: 'original', message_id: '1' } };
    spool.enqueue(input);
    await new Promise(resolve => setTimeout(resolve, 10));
    const file = readdirSync(root).find(file => file.endsWith('.json'))!;
    expect(JSON.parse(readFileSync(join(root, file), 'utf8'))).toEqual(input);
    spool.close(); fail = false;
    spool = new ReceiverSpool(root, 'http://fixture.invalid/channel', request);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(readdirSync(root)).toEqual([]);
    expect(delivered.at(-1)).toEqual(input);
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});
