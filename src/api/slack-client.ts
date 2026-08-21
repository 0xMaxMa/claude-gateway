/**
 * Thin Slack Web API wrapper — the outbound half of the Slack channel.
 *
 * Unlike LINE (`line-webhook-router.ts` uses `@line/bot-sdk`'s
 * `MessagingApiClient` + a 402-line reply-token TTL state machine in
 * `line-reply-manager.ts`), Slack has no reply-token expiry: `chat.postMessage`
 * works with the bot token at any time, so no reply-manager equivalent is
 * needed here — this is a plain fetch wrapper around the handful of Web API
 * methods the channel actually uses.
 */
import { createLogger } from '../logger';

const SLACK_API_BASE = 'https://slack.com/api';

export interface SlackClientOptions {
  botToken: string;
  logDir: string;
  /** Test-only override for the Web API base URL. Production uses the real default. */
  apiBase?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackClient {
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(opts: SlackClientOptions) {
    this.botToken = opts.botToken;
    this.apiBase = opts.apiBase ?? SLACK_API_BASE;
    this.logger = createLogger('slack-client', opts.logDir);
  }

  /**
   * form-urlencoded, not JSON: write-oriented methods (chat.postMessage,
   * reactions.*) accept a JSON body fine, but read/info methods
   * (users.info, conversations.info) do NOT reliably parse it — confirmed
   * live (users.info returned "user_not_found" for a real user id via JSON,
   * "ok":true via form-encoding). form-urlencoded is the one format every
   * Slack Web API method accepts, so use it uniformly rather than branching
   * per method.
   */
  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: params,
    });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) {
      this.logger.warn(`Slack API ${method} failed`, { error: json.error });
    }
    return json;
  }

  /**
   * Verify the token and fetch the workspace/team name — used as the
   * connect-flow's "Save" validation step (see 2b in the plan: reused from
   * openclaw's startup `auth.test` call), not just a startup check.
   */
  async authTest(): Promise<{ ok: boolean; team?: string; error?: string }> {
    const json = await this.call('auth.test', {});
    return { ok: json.ok, team: json.team as string | undefined, error: json.error };
  }

  /**
   * Post a reply. `unfurl_links: false` by default (see 2c — avoids link-preview
   * spam on every URL in an agent's reply; openclaw defaults the same way).
   * `threadTs`, when passed, replies in-thread instead of top-level.
   */
  async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackApiResponse> {
    return this.call('chat.postMessage', {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  /**
   * Ack-reaction (see 2c) — added to the inbound message on receipt, removed
   * once the reply posts. Replaces LINE's reply-token-TTL-driven slow-response
   * postback button: Slack has no such TTL, so a simple "seen" signal is a
   * proportionate substitute, not a scaled-down version of LINE's mechanism.
   * Best-effort: failures (e.g. already reacted, message deleted) are logged,
   * never thrown — an ack reaction is UX polish, not correctness-critical.
   */
  async addReaction(channel: string, timestamp: string, name = 'hourglass_flowing_sand'): Promise<void> {
    const json = await this.call('reactions.add', { channel, timestamp, name });
    if (!json.ok && json.error !== 'already_reacted') {
      this.logger.debug('addReaction failed', { error: json.error });
    }
  }

  async removeReaction(channel: string, timestamp: string, name = 'hourglass_flowing_sand'): Promise<void> {
    const json = await this.call('reactions.remove', { channel, timestamp, name });
    if (!json.ok && json.error !== 'no_reaction') {
      this.logger.debug('removeReaction failed', { error: json.error });
    }
  }

  /**
   * Best-effort display name for a pending-knock DM sender — mirrors LINE's
   * `getProfile()` backfill in line-webhook-router.ts. Needs the `users:read`
   * scope; returns undefined (never throws) if missing or the call fails, so
   * the pending list just falls back to "Unknown" same as before this existed.
   */
  async getUserDisplayName(userId: string): Promise<string | undefined> {
    const json = await this.call('users.info', { user: userId });
    if (!json.ok) return undefined;
    const user = json.user as
      | { profile?: { display_name?: string; real_name?: string }; real_name?: string }
      | undefined;
    return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || undefined;
  }

  /**
   * Best-effort channel name for a pending-knock channel — mirrors LINE's
   * `getGroupSummary()` backfill. Needs `channels:read` (public) / `groups:read`
   * (private); same graceful undefined-on-failure contract as above.
   */
  async getChannelName(channelId: string): Promise<string | undefined> {
    const json = await this.call('conversations.info', { channel: channelId });
    if (!json.ok) return undefined;
    const channel = json.channel as { name?: string } | undefined;
    return channel?.name || undefined;
  }
}
