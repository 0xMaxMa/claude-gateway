import crypto from 'crypto';

export interface VerifiedInitData {
  /** Telegram user id (stringified) proven by the signature. */
  userId: string;
}

/** Max age of a Telegram initData payload we still trust (replay bound). */
const INITDATA_MAX_AGE_SEC = 60 * 60;

/**
 * Verify a Telegram Mini App `initData` string against a bot token.
 *
 * Telegram signs the launch parameters so a Mini App can prove which user opened
 * it without any secret in the URL. The check (per Telegram's spec):
 *   secret_key      = HMAC_SHA256(key = "WebAppData", data = <bot token>)
 *   data_check_str  = every "key=value" except `hash`, sorted, joined by "\n"
 *   expected_hash   = HMAC_SHA256(key = secret_key, data = data_check_str)
 * and `expected_hash` must equal the payload's `hash` (timing-safe).
 *
 * Returns the verified user id, or null if the payload is missing fields,
 * tampered, stale, or the signature does not match. The caller is still
 * responsible for authorizing that user for the target agent — a valid
 * signature only proves *who* opened the Mini App, not *what* they may see.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
): VerifiedInitData | null {
  if (!initData || !botToken) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hash, 'hex');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  // Reject stale payloads (replay bound). auth_date is unix seconds.
  const authDate = Number(params.get('auth_date') ?? '');
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (Date.now() / 1000 - authDate > INITDATA_MAX_AGE_SEC) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as { id?: number | string };
    if (user.id === undefined || user.id === null || user.id === '') return null;
    return { userId: String(user.id) };
  } catch {
    return null;
  }
}
