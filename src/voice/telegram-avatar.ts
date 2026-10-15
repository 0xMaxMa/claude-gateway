/**
 * A Telegram bot's profile photo for the `/call` page. Every Bot API request,
 * the file link included, carries the bot token, so the photo is fetched here
 * and served by the gateway; no Telegram URL reaches the browser or a log.
 */
export interface BotAvatar { bytes: Buffer; contentType: string }

/** Telegram keeps a file link valid for at least an hour. */
export const BOT_AVATAR_TTL_MS = 60 * 60 * 1000;
/** A failed lookup is retried sooner than a bot that has no photo. */
const BOT_AVATAR_RETRY_MS = 5 * 60 * 1000;
export const BOT_AVATAR_MAX_BYTES = 1024 * 1024;
/** The page shows the avatar at 112 CSS px; 320 px stays sharp on a 3x screen. */
const BOT_AVATAR_MIN_SIDE = 320;

type BotApiResult<T> = { ok: boolean; result?: T };
interface PhotoSize { file_id: string; width: number; height: number; file_size?: number }

const IMAGE_TYPES: Array<[string, (bytes: Buffer) => boolean]> = [
  ['image/jpeg', bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/png', bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
];

export class TelegramBotAvatars {
  private readonly cache = new Map<string, { token: string; expiresAt: number; avatar: Promise<BotAvatar | null> }>();
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  /** The agent's bot photo, or null when the bot has none or Telegram cannot be reached. */
  get(agentId: string, botToken: string): Promise<BotAvatar | null> {
    const cached = this.cache.get(agentId);
    if (cached && cached.token === botToken && cached.expiresAt > this.now()) return cached.avatar;
    const entry = { token: botToken, expiresAt: this.now() + BOT_AVATAR_TTL_MS, avatar: Promise.resolve<BotAvatar | null>(null) };
    entry.avatar = this.fetchAvatar(botToken).then(
      avatar => avatar,
      () => { entry.expiresAt = this.now() + BOT_AVATAR_RETRY_MS; return null; });
    this.cache.set(agentId, entry);
    return entry.avatar;
  }

  private async fetchAvatar(token: string): Promise<BotAvatar | null> {
    const me = await this.call<{ id: number }>(token, 'getMe', {});
    const photos = await this.call<{ photos: PhotoSize[][] }>(token, 'getUserProfilePhotos', { user_id: me.id, limit: 1 });
    const sizes = [...(photos.photos[0] ?? [])].sort((a, b) => a.width - b.width);
    const size = sizes.find(candidate => Math.min(candidate.width, candidate.height) >= BOT_AVATAR_MIN_SIDE) ?? sizes.at(-1);
    if (!size) return null;
    const file = await this.call<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: size.file_id });
    const path = file.file_path;
    if (!path || path.split('/').includes('..') || !/^[A-Za-z0-9_./-]+$/.test(path) || (file.file_size ?? 0) > BOT_AVATAR_MAX_BYTES) return null;
    const response = await this.request(`https://api.telegram.org/file/bot${token}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('BOT_AVATAR_UNAVAILABLE');
    if (Number(response.headers.get('content-length')) > BOT_AVATAR_MAX_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > BOT_AVATAR_MAX_BYTES) return null;
    const type = IMAGE_TYPES.find(([, matches]) => matches(bytes));
    return type ? { bytes, contentType: type[0] } : null;
  }

  private async call<T>(token: string, method: string, body: object): Promise<T> {
    const response = await this.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const parsed = await response.json().catch(() => undefined) as BotApiResult<T> | undefined;
    if (!response.ok || !parsed?.ok || parsed.result === undefined) throw new Error('BOT_AVATAR_UNAVAILABLE');
    return parsed.result;
  }
}
