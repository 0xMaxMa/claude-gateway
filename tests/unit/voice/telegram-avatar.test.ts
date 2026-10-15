import express from 'express';
import request from 'supertest';
import { createVoiceCallRouter } from '../../../src/api/voice-call-router';
import { voiceCallPairings } from '../../../src/voice/call-pairing';
import { BOT_AVATAR_TTL_MS, TelegramBotAvatars } from '../../../src/voice/telegram-avatar';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';
import type { VoiceApi } from '../../../src/api/voice-router';

const BOT_TOKEN = '123456:fixture-bot-token';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });

/** Telegram's Bot API for one bot, answering as it does for a bot with or without a profile photo. */
function botApi(options: { photos?: Array<{ file_id: string; width: number; height: number }>; image?: Buffer } = {}) {
  const urls: string[] = [];
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url); urls.push(href);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (href.endsWith('/getMe')) return json({ id: 123456, is_bot: true, first_name: 'Fixture' });
    if (href.endsWith('/getUserProfilePhotos')) return json({ total_count: options.photos ? 1 : 0, photos: options.photos ? [options.photos] : [], asked: body });
    if (href.endsWith('/getFile')) return json({ file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: 8 });
    if (href.includes('/file/bot')) return new Response(new Uint8Array(options.image ?? JPEG), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls, calls: fetch };
}

function app(avatars: TelegramBotAvatars) {
  const configs = new Map([['a', { id: 'a', telegram: { botToken: BOT_TOKEN } } as AgentConfig]]);
  const server = express();
  server.use('/voice-call', createVoiceCallRouter({ agents: new Map<string, AgentRunner>(), configs, voiceApi: {} as VoiceApi, basePath: () => '', telegramStateDir: () => '/nonexistent', avatars }));
  return server;
}

test("serves the bot's profile photo for a live call link, never the Telegram URL or token", async () => {
  const api = botApi({ photos: [{ file_id: 'small', width: 160, height: 160 }, { file_id: 'medium', width: 320, height: 320 }, { file_id: 'large', width: 640, height: 640 }] });
  const pairingId = voiceCallPairings.create('a', '42');
  const response = await request(app(new TelegramBotAvatars(api.fetch))).get(`/voice-call/${pairingId}/avatar`).buffer(true);
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe('image/jpeg');
  expect(response.headers['cache-control']).toBe('private, max-age=3600');
  expect(Buffer.from(response.body)).toEqual(JPEG);
  // The smallest photo still sharp at the page's size on a 3x screen.
  expect(api.urls.at(-1)).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/photos/medium.jpg`);
  const exposed = JSON.stringify(response.headers) + response.body.toString('latin1');
  expect(exposed).not.toContain(BOT_TOKEN);
  expect(exposed).not.toContain('api.telegram.org');
});

test('no photo, a failed lookup or an unknown link answers 404, which leaves the page on its initial', async () => {
  const pairingId = voiceCallPairings.create('a', '42');
  const none = await request(app(new TelegramBotAvatars(botApi().fetch))).get(`/voice-call/${pairingId}/avatar`);
  expect(none.status).toBe(404);
  expect(none.headers['cache-control']).toBe('no-store');
  const offline = new TelegramBotAvatars((async () => { throw new Error('network down'); }) as unknown as typeof fetch);
  expect((await request(app(offline)).get(`/voice-call/${pairingId}/avatar`)).status).toBe(404);
  const notImage = new TelegramBotAvatars(botApi({ photos: [{ file_id: 'x', width: 640, height: 640 }], image: Buffer.from('<html>') }).fetch);
  expect((await request(app(notImage)).get(`/voice-call/${pairingId}/avatar`)).status).toBe(404);
  const api = botApi({ photos: [{ file_id: 'x', width: 640, height: 640 }] });
  expect((await request(app(new TelegramBotAvatars(api.fetch))).get('/voice-call/unknown/avatar')).status).toBe(404);
  expect(api.calls).not.toHaveBeenCalled();
});

test('the photo is fetched once per agent for an hour, then again', async () => {
  const api = botApi({ photos: [{ file_id: 'x', width: 640, height: 640 }] });
  let now = 1_000_000;
  const avatars = new TelegramBotAvatars(api.fetch, () => now);
  const server = app(avatars), pairingId = voiceCallPairings.create('a', '42');
  await request(server).get(`/voice-call/${pairingId}/avatar`);
  await request(server).get(`/voice-call/${pairingId}/avatar`);
  expect(api.calls).toHaveBeenCalledTimes(4); // getMe, getUserProfilePhotos, getFile, the file
  now += BOT_AVATAR_TTL_MS + 1;
  expect((await request(server).get(`/voice-call/${pairingId}/avatar`)).status).toBe(200);
  expect(api.calls).toHaveBeenCalledTimes(8);
});
