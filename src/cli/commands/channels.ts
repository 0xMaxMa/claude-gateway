import { CliConfigView, resolveUrl, resolveKey, request } from '../http-client';
import { printResult } from '../output';

/**
 * `channels pending|approve|deny` — manage incoming Telegram/Discord pairing
 * requests for an agent (replaces `make pair agent=X code=Y channel=Z`).
 *
 * Scoped to the channels that actually expose a code-based pairing queue
 * today (GET .../pending, POST .../approve, POST .../deny — see
 * src/api/router.ts). LINE and Slack use a different model (a "recently
 * dropped senders" list you allowlist directly, no approval code) so they
 * aren't part of this command. Adding a future channel with the same
 * approve/deny-by-code shape only requires adding it to PAIRING_CHANNELS below
 * — no other code here is channel-specific.
 */
export const PAIRING_CHANNELS = ['telegram', 'discord'] as const;
export type PairingChannel = (typeof PAIRING_CHANNELS)[number];

function isPairingChannel(v: string | undefined): v is PairingChannel {
  return !!v && (PAIRING_CHANNELS as readonly string[]).includes(v);
}

export async function runChannels(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb || flags.help === true) {
    printHelp();
    return verb ? 0 : 1;
  }

  const agentId = typeof flags.agent === 'string' ? flags.agent : undefined;
  if (!agentId) {
    process.stderr.write('Missing required flag: --agent <id>\n\n');
    printHelp();
    return 1;
  }

  const channelFlag = typeof flags.channel === 'string' ? flags.channel : undefined;
  if (channelFlag !== undefined && !isPairingChannel(channelFlag)) {
    process.stderr.write(`Invalid --channel '${channelFlag}'. Expected one of: ${PAIRING_CHANNELS.join(', ')}\n`);
    return 1;
  }

  const baseUrl = resolveUrl({ flagUrl: strFlag(flags.url), env: process.env, config });
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const compact = flags.json === true;

  switch (verb) {
    case 'pending': {
      const channels = channelFlag ? [channelFlag] : PAIRING_CHANNELS;
      const byChannel: Record<string, unknown> = {};
      for (const channel of channels) {
        const result = await request({ method: 'GET', path: `/v1/agents/${encodeURIComponent(agentId)}/${channel}/pending`, baseUrl, key });
        byChannel[channel] = (result.data as { pending?: unknown[] })?.pending ?? [];
      }
      printResult(byChannel, compact);
      return 0;
    }
    case 'approve':
    case 'deny': {
      if (!channelFlag) {
        process.stderr.write(`Missing required flag: --channel <${PAIRING_CHANNELS.join('|')}>\n\n`);
        printHelp();
        return 1;
      }
      const code = typeof flags.code === 'string' ? flags.code : undefined;
      if (!code) {
        process.stderr.write('Missing required flag: --code <code>\n\n');
        printHelp();
        return 1;
      }
      const result = await request({
        method: 'POST',
        path: `/v1/agents/${encodeURIComponent(agentId)}/${channelFlag}/${verb}`,
        baseUrl,
        key,
        body: { code },
      });
      printResult(result.data, compact);
      return 0;
    }
    default:
      process.stderr.write(`Unknown: channels ${verb} (expected pending|approve|deny)\n\n`);
      printHelp();
      return 1;
  }
}

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}



function printHelp(): void {
  const lines = [
    'claude-gateway channels — manage incoming Telegram/Discord pairing requests',
    '',
    `  channels pending --agent <id> [--channel ${PAIRING_CHANNELS.join('|')}]           List pending requests (both channels if omitted)`,
    `  channels approve --agent <id> --channel <${PAIRING_CHANNELS.join('|')}> --code <code>   Approve a pending request`,
    `  channels deny    --agent <id> --channel <${PAIRING_CHANNELS.join('|')}> --code <code>   Deny and remove a pending request`,
  ];
  process.stderr.write(lines.join('\n') + '\n');
}
