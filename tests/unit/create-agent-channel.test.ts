/**
 * Tests for channel selection in create-agent wizard.
 */

jest.mock('https');

import { SUPPORTED_CHANNELS, DISCORD_TOKEN_REGEX, verifyDiscordBotToken } from '../../scripts/create-agent';
import * as https from 'https';
import { EventEmitter } from 'events';

describe('SUPPORTED_CHANNELS', () => {
  it('CA1: telegram is available', () => {
    const tg = SUPPORTED_CHANNELS.find(c => c.id === 'telegram');
    expect(tg).toBeDefined();
    expect(tg!.available).toBe(true);
  });

  it('CA2: discord is available', () => {
    const dc = SUPPORTED_CHANNELS.find(c => c.id === 'discord');
    expect(dc).toBeDefined();
    expect(dc!.available).toBe(true);
  });

  it('CA3: slack is present but not available', () => {
    const sl = SUPPORTED_CHANNELS.find(c => c.id === 'slack');
    expect(sl).toBeDefined();
    expect(sl!.available).toBe(false);
  });

  it('CA4: all entries have id, label, available fields', () => {
    for (const ch of SUPPORTED_CHANNELS) {
      expect(typeof ch.id).toBe('string');
      expect(typeof ch.label).toBe('string');
      expect(typeof ch.available).toBe('boolean');
    }
  });
});

describe('DISCORD_TOKEN_REGEX', () => {
  it('CA5: accepts valid Discord token format', () => {
    const validToken = 'MTAxMTk2NzUwMTA5MzYwNzE1Ng.FAKETO.fake_test_token_not_real_xxxxxxxxxxx';
    expect(DISCORD_TOKEN_REGEX.test(validToken)).toBe(true);
  });

  it('CA6: accepts another valid Discord token format', () => {
    const validToken = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.FAKETO.fake_test_token_not_real_abcdefghij';
    expect(DISCORD_TOKEN_REGEX.test(validToken)).toBe(true);
  });

  it('CA7: rejects Telegram token format', () => {
    const telegramToken = '123456789:AAHfiqksKZ8WmHPDKxxxxxxxxxxxxxxxx';
    expect(DISCORD_TOKEN_REGEX.test(telegramToken)).toBe(false);
  });

  it('CA8: rejects short/malformed tokens', () => {
    expect(DISCORD_TOKEN_REGEX.test('short.token')).toBe(false);
    expect(DISCORD_TOKEN_REGEX.test('')).toBe(false);
    expect(DISCORD_TOKEN_REGEX.test('abc.def')).toBe(false);
  });
});

describe('verifyDiscordBotToken', () => {
  afterEach(() => jest.resetAllMocks());

  function mockHttpsRequest(statusCode: number, body: string): void {
    const fakeRes = Object.assign(new EventEmitter(), { statusCode });
    (https.request as jest.Mock).mockImplementation((_opts: any, cb?: any) => {
      const req = new EventEmitter() as any;
      req.end = () => {
        if (cb) {
          cb(fakeRes);
          fakeRes.emit('data', body);
          fakeRes.emit('end');
        }
      };
      return req;
    });
  }

  it('CA9: returns ok=true with username on 200 response', async () => {
    mockHttpsRequest(200, JSON.stringify({ username: 'MyBot', id: '123' }));
    const result = await verifyDiscordBotToken('valid.token.format12345678901234567');
    expect(result.ok).toBe(true);
    expect(result.username).toBe('MyBot');
  });

  it('CA10: returns ok=false on 401 response', async () => {
    mockHttpsRequest(401, JSON.stringify({ message: '401: Unauthorized' }));
    const result = await verifyDiscordBotToken('invalid.token.format12345678901234567');
    expect(result.ok).toBe(false);
  });

  it('CA11: returns ok=false on network error', async () => {
    (https.request as jest.Mock).mockImplementation(() => {
      const req = new EventEmitter() as any;
      req.end = () => req.emit('error', new Error('connection refused'));
      return req;
    });
    const result = await verifyDiscordBotToken('any.token.format123456789012345678');
    expect(result.ok).toBe(false);
  });
});
