import { createHash } from 'crypto';

export interface GithubAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
}

/** The wire answer of GET /api/v1/connectors/github/account, status included. */
export type GithubAccountReply =
  | { status: 200; body: { connected: false } }
  | { status: 200; body: { connected: true; valid: true; account: GithubAccount } }
  | { status: 200; body: { connected: true; valid: false; reason: 'token_rejected' } }
  | { status: 502; body: { error: 'github_unreachable' } };

const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

const UNREACHABLE: GithubAccountReply = { status: 502, body: { error: 'github_unreachable' } };

function parseAccount(raw: unknown): GithubAccount | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const user = raw as Record<string, unknown>;
  if (typeof user.login !== 'string' || !user.login) return undefined;
  if (typeof user.avatar_url !== 'string' || typeof user.html_url !== 'string') return undefined;
  if (user.name !== null && user.name !== undefined && typeof user.name !== 'string') return undefined;
  return {
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
    avatarUrl: user.avatar_url,
    htmlUrl: user.html_url,
  };
}

/**
 * Asks api.github.com whose token this is. Accepted and rejected answers are
 * cached for a minute, keyed by a hash of the token so the token itself is never
 * held as a map key; an unreachable answer is not cached, so a retry really retries.
 */
export function createGithubAccountLookup(fetchGithub: typeof fetch = fetch) {
  const cache = new Map<string, { expiresAt: number; reply: GithubAccountReply }>();

  async function ask(token: string): Promise<GithubAccountReply> {
    try {
      const res = await fetchGithub('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-gateway',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) {
        await res.body?.cancel();
        return { status: 200, body: { connected: true, valid: false, reason: 'token_rejected' } };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return UNREACHABLE;
      }
      const account = parseAccount(await res.json());
      return account ? { status: 200, body: { connected: true, valid: true, account } } : UNREACHABLE;
    } catch {
      return UNREACHABLE;
    }
  }

  return async function lookup(token: string): Promise<GithubAccountReply> {
    const fingerprint = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const hit = cache.get(fingerprint);
    if (hit && hit.expiresAt > now) return hit.reply;

    const reply = await ask(token);
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    if (reply.status === 200) cache.set(fingerprint, { expiresAt: Date.now() + CACHE_TTL_MS, reply });
    return reply;
  };
}
