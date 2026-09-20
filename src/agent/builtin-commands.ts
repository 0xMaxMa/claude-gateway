import { CHAT_CHANNELS, type ChatChannelOrApi } from '../history/types';

export type CommandChannel = ChatChannelOrApi;

interface CommandDef {
  channels: CommandChannel[];
  /** word-boundary check: true (default) = /^\/cmd\b/, false = /^\/cmd(\s|$)/ */
  wordBoundary?: boolean;
}

export const BUILTIN_COMMANDS: Record<string, CommandDef> = {
  session:  { channels: [...CHAT_CHANNELS, 'api'] },
  sessions: { channels: [...CHAT_CHANNELS, 'api'] },
  new:      { channels: ['telegram', 'discord'], wordBoundary: false },
  rename:   { channels: ['telegram'], wordBoundary: false },
  clear:    { channels: [...CHAT_CHANNELS, 'api'] },
  compact:  { channels: [...CHAT_CHANNELS, 'api'] },
  stop:     { channels: [...CHAT_CHANNELS, 'api'], wordBoundary: false },
  model:    { channels: ['telegram', 'discord', 'line', 'api'] },
  models:   { channels: ['telegram', 'discord', 'line'] },
  restart:  { channels: [...CHAT_CHANNELS, 'api'], wordBoundary: false },
  start:    { channels: ['telegram'] },
  help:     { channels: [...CHAT_CHANNELS, 'api'] },
  status:   { channels: ['telegram'] },
};

const _cache = new Map<CommandChannel, RegExp>();

function buildRegex(channel: CommandChannel): RegExp {
  const parts = Object.entries(BUILTIN_COMMANDS)
    .filter(([, def]) => def.channels.includes(channel))
    .map(([cmd, def]) =>
      def.wordBoundary === false ? `^\/${cmd}(\\s|$)` : `^\/${cmd}\\b`
    );
  // No commands registered for this channel (e.g. 'line') → match nothing.
  // `new RegExp('')` matches EVERY string, which would misroute all messages
  // into the command handler so they'd never reach the agent.
  if (parts.length === 0) return /(?!)/;
  return new RegExp(parts.join('|'));
}

function getRegex(channel: CommandChannel): RegExp {
  let re = _cache.get(channel);
  if (!re) {
    re = buildRegex(channel);
    _cache.set(channel, re);
  }
  return re;
}

export function isBuiltinCommand(content: string, channel: CommandChannel): boolean {
  return getRegex(channel).test(content.trim());
}
