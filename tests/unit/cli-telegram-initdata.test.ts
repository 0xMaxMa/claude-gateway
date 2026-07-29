import crypto from 'crypto';
import { verifyTelegramInitData } from '../../src/cli-viewer/telegram-initdata';

/**
 * Telegram Mini App initData verification. The gateway trusts initData to prove
 * *who* opened the `/cli` Mini App without any secret in the URL, so the HMAC
 * check must be exact: a tampered field, a foreign signature, a stale payload,
 * or a missing user must all fail closed.
 */
const BOT_TOKEN = '123456:test-bot-token-abcdef';

/** Build a validly-signed initData string exactly the way Telegram does. */
function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function freshFields(userId = 777): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAA',
    user: JSON.stringify({ id: userId, first_name: 'Test' }),
  };
}

describe('verifyTelegramInitData', () => {
  it('accepts a valid payload and returns the user id', () => {
    const initData = signInitData(freshFields(777));
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toEqual({ userId: '777' });
  });

  it('rejects a tampered field (signature no longer matches)', () => {
    const params = new URLSearchParams(signInitData(freshFields(777)));
    params.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));
    expect(verifyTelegramInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signInitData(freshFields(777), 'other:token');
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it('rejects a stale payload (auth_date too old)', () => {
    const stale = freshFields(777);
    stale.auth_date = String(Math.floor(Date.now() / 1000) - 7200); // 2h old
    const initData = signInitData(stale);
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it('rejects a missing hash / missing user / empty inputs', () => {
    expect(verifyTelegramInitData('', BOT_TOKEN)).toBeNull();
    expect(verifyTelegramInitData('auth_date=123', BOT_TOKEN)).toBeNull();
    const noUser = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) });
    expect(verifyTelegramInitData(noUser, BOT_TOKEN)).toBeNull();
    const valid = signInitData(freshFields(1));
    expect(verifyTelegramInitData(valid, '')).toBeNull();
  });
});
