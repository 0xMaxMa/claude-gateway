export type CommandChannel = 'telegram' | 'discord' | 'line' | 'api';

interface CommandDef {
  channels: CommandChannel[];
  /** word-boundary check: true (default) = /^\/cmd\b/, false = /^\/cmd(\s|$)/ */
  wordBoundary?: boolean;
}

export const BUILTIN_COMMANDS: Record<string, CommandDef> = {
  session:  { channels: ['telegram', 'discord', 'api'] },
  sessions: { channels: ['telegram', 'discord', 'api'] },
  new:      { channels: ['telegram', 'discord'], wordBoundary: false },
  rename:   { channels: ['telegram'], wordBoundary: false },
  clear:    { channels: ['telegram', 'api'] },
  compact:  { channels: ['telegram', 'api'] },
  stop:     { channels: ['telegram', 'api'], wordBoundary: false },
  model:    { channels: ['telegram', 'discord', 'api'] },
  models:   { channels: ['telegram'] },
  restart:  { channels: ['telegram', 'api'], wordBoundary: false },
  start:    { channels: ['telegram'] },
  help:     { channels: ['telegram'] },
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
