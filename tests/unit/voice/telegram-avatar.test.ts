import express from 'express';
import request from 'supertest';
import { createVoiceCallRouter } from '../../../src/api/voice-call-router';
import { voiceCallPairings } from '../../../src/voice/call-pairing';
import { TelegramBotAvatars } from '../../../src/voice/telegram-avatar';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';
import type { VoiceApi } from '../../../src/api/voice-router';

const BOT_TOKEN = '123456:fixture-bot-token';
const JPEG = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, 2, 3, 4]);
const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
type Size = { file_id: string; file_unique_id: string; width: number; height: number };
const photo = (id: string): Size[] => [160, 320, 640].map(side => ({ file_id: `${id}-${side}`, file_unique_id: `${id}-${side}-unique`, width: side, height: side }));

/** Telegram's Bot API for one bot whose name and photo the test changes, as BotFather would. */
function botApi(state: { name?: string; photo?: Size[]; image?: Buffer; down?: boolean; slow?: Promise<void> } = {}) {
  const urls: string[] = [];
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url); urls.push(href);
    if (state.slow) await state.slow;
    if (state.down) throw new Error('network down');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (href.endsWith('/getMe')) return json({ id: 123456, is_bot: true, first_name: state.name ?? 'Fixture' });
    if (href.endsWith('/getUserProfilePhotos')) return json({ total_count: state.photo ? 1 : 0, photos: state.photo ? [state.photo] : [] });
    if (href.endsWith('/getFile')) return json({ file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: 8 });
    if (href.includes('/file/bot')) return new Response(new Uint8Array(state.image ?? JPEG(href.length % 250)), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  });
  const downloads = () => urls.filter(url => url.includes('/file/bot')).length;
  return { state, fetch: fetch as unknown as typeof globalThis.fetch, urls, downloads };
}

function app(avatars: TelegramBotAvatars) {
  const configs = new Map([['a', { id: 'getpod', telegram: { botToken: BOT_TOKEN } } as AgentConfig]]);
  const server = express();
  server.use('/voice-call', createVoiceCallRouter({ agents: new Map<string, AgentRunner>(), configs, voiceApi: {} as VoiceApi, basePath: () => '', telegramStateDir: () => '/nonexistent', avatars }));
  return server;
}
/** Open the call page as Telegram does, then load the avatar it names, if any. */
async function open(server: express.Express, pairingId: string) {
  const page = await request(server).get(`/voice-call/${pairingId}`);
  const src = /<img id="photo" alt="" src="([^"]+)">/.exec(page.text)?.[1]?.replace(/&amp;/g, '&');
  const avatar = src ? await request(server).get(src).buffer(true) : undefined;
  return { page, src, avatar, name: /<div class="name">([^<]*)<\/div>/.exec(page.text)?.[1] };
}

test("the page shows the bot's Telegram name and photo, served without the Telegram URL or token", async () => {
  const api = botApi({ name: 'Meguri - Develop', photo: photo('first') });
  const pairingId = voiceCallPairings.create('a', '42');
  const { page, src, avatar, name } = await open(app(new TelegramBotAvatars(api.fetch)), pairingId);
  expect(name).toBe('Meguri - Develop');
  expect(src).toBe(`/voice-call/${pairingId}/avatar?v=first-320-unique`);
  expect(avatar!.status).toBe(200);
  expect(avatar!.headers['content-type']).toBe('image/jpeg');
  expect(avatar!.headers['cache-control']).toBe('private, max-age=3600');
  // The smallest photo still sharp at the page's size on a 3x screen.
  expect(api.urls.at(-1)).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/photos/first-320.jpg`);
  const exposed = page.text + JSON.stringify(page.headers) + JSON.stringify(avatar!.headers) + avatar!.body.toString('latin1');
  expect(exposed).not.toContain(BOT_TOKEN);
  expect(exposed).not.toContain('api.telegram.org');
});

test('a photo set after a call without one shows on the next call, and a changed photo replaces it', async () => {
  const api = botApi({ name: 'Meguri' });
  const server = app(new TelegramBotAvatars(api.fetch)), pairingId = voiceCallPairings.create('a', '42');
  const none = await open(server, pairingId);
  // The page still asks (a photo may be set any time); the 404 leaves the initial under it showing.
  expect(none.page.text).toContain(`<div class="avatar" id="avatar" aria-hidden="true">M<img id="photo" alt="" src="/voice-call/${pairingId}/avatar"></div>`);
  expect(none.avatar!.status).toBe(404);
  expect(none.avatar!.headers['cache-control']).toBe('no-store');

  api.state.photo = photo('first');
  const first = await open(server, pairingId);
  expect(first.src).toContain('v=first-320-unique');
  expect(first.avatar!.status).toBe(200);
  const firstBytes = Buffer.from(first.avatar!.body);

  // The same photo is not downloaded again.
  await open(server, pairingId);
  expect(api.downloads()).toBe(1);

  api.state.photo = photo('second');
  const second = await open(server, pairingId);
  expect(second.src).toContain('v=second-320-unique');
  expect(Buffer.from(second.avatar!.body)).not.toEqual(firstBytes);
  expect(api.downloads()).toBe(2);
});

test('the name falls back to the agent id, and an unreachable Telegram keeps the last known profile', async () => {
  const pairingId = voiceCallPairings.create('a', '42');
  const offline = await open(app(new TelegramBotAvatars(botApi({ down: true }).fetch)), pairingId);
  expect(offline.name).toBe('a');
  expect(offline.avatar!.status).toBe(404);
  expect(offline.page.status).toBe(200);

  const api = botApi({ name: 'Meguri', photo: photo('first') });
  const server = app(new TelegramBotAvatars(api.fetch));
  expect((await open(server, pairingId)).name).toBe('Meguri');
  api.state.down = true;
  const later = await open(server, pairingId);
  expect(later.name).toBe('Meguri');
  expect(later.avatar!.status).toBe(200);

  const notImage = await open(app(new TelegramBotAvatars(botApi({ photo: photo('x'), image: Buffer.from('<html>') }).fetch)), pairingId);
  expect(notImage.src).toBe(`/voice-call/${pairingId}/avatar`);
  expect(notImage.avatar!.status).toBe(404);
  expect((await request(server).get('/voice-call/unknown/avatar')).status).toBe(404);
});

test('a slow Telegram never holds the call page: it opens with what is known, and the lookup lands for the next call', async () => {
  const api = botApi({ name: 'Meguri', photo: photo('first') });
  const server = app(new TelegramBotAvatars(api.fetch, 50)), pairingId = voiceCallPairings.create('a', '42');
  let answer = () => {};
  api.state.slow = new Promise<void>(resolve => { answer = resolve; });
  // Nothing known yet: the page opens at once with the agent id, and still asks for the photo.
  const page = await request(server).get(`/voice-call/${pairingId}`);
  expect(/<div class="name">([^<]*)<\/div>/.exec(page.text)?.[1]).toBe('a');
  const src = /<img id="photo" alt="" src="([^"]+)">/.exec(page.text)?.[1];
  expect(src).toBe(`/voice-call/${pairingId}/avatar`);
  // The photo request waits for the lookup and shows the bot's photo once Telegram answers, uncached.
  const photoRequest = request(server).get(src!).buffer(true).then(response => response);
  await new Promise(resolve => setTimeout(resolve, 20));
  // The bot's id is in its token: the photo lookup does not wait for getMe.
  expect(api.urls.map(url => url.split('/').pop())).toEqual(['getMe', 'getUserProfilePhotos']);
  answer(); api.state.slow = undefined;
  const cold = await photoRequest;
  expect(cold.status).toBe(200);
  expect(cold.headers['content-type']).toBe('image/jpeg');
  expect(cold.headers['cache-control']).toBe('no-store');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await open(server, pairingId)).name).toBe('Meguri');
  // Renamed in BotFather while Telegram is slow: the last known profile, photo included, then the new name.
  api.state.name = 'Meguri 2';
  api.state.slow = new Promise<void>(resolve => { answer = resolve; });
  const known = await open(server, pairingId);
  expect(known.name).toBe('Meguri');
  expect(known.avatar!.status).toBe(200);
  answer(); api.state.slow = undefined;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await open(server, pairingId)).name).toBe('Meguri 2');
}, 4000);
