/**
 * A Telegram bot's name and profile photo for the `/call` page. Every Bot API
 * request, the file link included, carries the bot token, so the gateway looks
 * them up and serves the photo itself; no Telegram URL reaches the browser or a log.
 */
export interface BotAvatar { bytes: Buffer; contentType: string }
/** What the call page shows for the bot. `photoId` (Telegram's `file_unique_id`)
 * changes when the photo does, so it versions the avatar URL. */
export interface BotProfile { name?: string; photoId?: string; avatar: BotAvatar | null }

export const BOT_AVATAR_MAX_BYTES = 1024 * 1024;
/** The page shows the avatar at 112 CSS px; 320 px stays sharp on a 3x screen. */
const BOT_AVATAR_MIN_SIDE = 320;
/** How long a call page waits for the lookup before it renders with what is already known. */
const PAGE_LOOKUP_WAIT_MS = 1500;

type BotApiResult<T> = { ok: boolean; result?: T };
interface PhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }

const IMAGE_TYPES: Array<[string, (bytes: Buffer) => boolean]> = [
  ['image/jpeg', bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/png', bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
];

export class TelegramBotAvatars {
  private readonly profiles = new Map<string, BotProfile & { token: string }>();
  private readonly lookups = new Map<string, Promise<BotProfile>>();
  constructor(private readonly request: typeof fetch = fetch, private readonly pageWaitMs = PAGE_LOOKUP_WAIT_MS) {}

  /** The profile a call page renders with: the fresh lookup when it answers within
   * `pageWaitMs`, otherwise the last known one while the lookup finishes for the next call. */
  async forPage(agentId: string, botToken: string): Promise<BotProfile> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const known = new Promise<BotProfile>(resolve => { timer = setTimeout(() => resolve(this.known(agentId, botToken) ?? { avatar: null }), this.pageWaitMs); });
    try { return await Promise.race([this.refresh(agentId, botToken), known]); } finally { clearTimeout(timer); }
  }

  /** Look the bot up again, as each call page opens: a renamed bot or a new photo
   * shows on the next call. The photo is downloaded only when it changed. When
   * Telegram cannot be reached the last known profile stands. */
  refresh(agentId: string, botToken: string): Promise<BotProfile> {
    const running = this.lookups.get(agentId);
    if (running) return running;
    const lookup = this.lookUp(agentId, botToken).finally(() => this.lookups.delete(agentId));
    this.lookups.set(agentId, lookup);
    return lookup;
  }

  /** The photo the page was rendered with; looked up once if this process has none yet. */
  async avatar(agentId: string, botToken: string): Promise<BotAvatar | null> {
    return (this.known(agentId, botToken) ?? await this.refresh(agentId, botToken)).avatar;
  }

  private known(agentId: string, botToken: string): BotProfile | undefined {
    const known = this.profiles.get(agentId);
    return known?.token === botToken ? known : undefined;
  }

  private async lookUp(agentId: string, token: string): Promise<BotProfile> {
    const previous = this.known(agentId, token);
    try {
      // A bot token starts with the bot's user id, so the photo lookup need not wait for getMe.
      const id = /^(\d+):/.exec(token)?.[1];
      const me = this.call<{ id: number; first_name?: string }>(token, 'getMe', {});
      const photosFor = (userId: number | string) => this.call<{ photos: PhotoSize[][] }>(token, 'getUserProfilePhotos', { user_id: Number(userId), limit: 1 });
      const [bot, photos] = id ? await Promise.all([me, photosFor(id)]) : await me.then(async found => [found, await photosFor(found.id)] as const);
      const sizes = [...(photos.photos[0] ?? [])].sort((a, b) => a.width - b.width);
      const size = sizes.find(candidate => Math.min(candidate.width, candidate.height) >= BOT_AVATAR_MIN_SIDE) ?? sizes.at(-1);
      const avatar = !size ? null : previous?.photoId === size.file_unique_id ? previous.avatar : await this.download(token, size);
      const profile = { token, name: bot.first_name?.trim() || undefined, photoId: avatar ? size?.file_unique_id : undefined, avatar };
      this.profiles.set(agentId, profile);
      return profile;
    } catch {
      return previous ?? { avatar: null };
    }
  }

  private async download(token: string, size: PhotoSize): Promise<BotAvatar | null> {
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

/** The gateway's one cache: the `/call` button warms it, so the page opening next finds the bot already looked up. */
export const telegramBotAvatars = new TelegramBotAvatars();
