import { CHAT_CHANNELS } from '../../src/history/types';
import { isBuiltinCommand, BUILTIN_COMMANDS } from '../../src/agent/builtin-commands';

describe('isBuiltinCommand', () => {
  // ── Telegram ──────────────────────────────────────────────────────────────
  describe('telegram', () => {
    const yes = (cmd: string) => expect(isBuiltinCommand(cmd, 'telegram')).toBe(true);
    const no  = (cmd: string) => expect(isBuiltinCommand(cmd, 'telegram')).toBe(false);

    it('matches all telegram built-in commands', () => {
      yes('/session');
      yes('/sessions');
      yes('/new');
      yes('/new my-session');
      yes('/rename foo');
      yes('/clear');
      yes('/compact');
      yes('/stop');
      yes('/model');
      yes('/models');
      yes('/restart');
      yes('/start');
      yes('/help');
      yes('/status');
    });

    it('handles leading whitespace', () => {
      yes('  /session');
      yes('  /clear');
    });

    it('does not match partial command names', () => {
      no('/sessions2');
      no('/clearall');
      no('/stopping');
    });

    it('does not match plain text', () => {
      no('hello /session');
      no('session');
      no('save my note');
    });

    it('does not match api-only commands', () => {
      // /restart and /model are also on telegram so skip those
      // no telegram-only exclusions needed — all api cmds are subset of telegram
    });
  });

  // ── Discord ───────────────────────────────────────────────────────────────
  describe('discord', () => {
    const yes = (cmd: string) => expect(isBuiltinCommand(cmd, 'discord')).toBe(true);
    const no  = (cmd: string) => expect(isBuiltinCommand(cmd, 'discord')).toBe(false);

    it('matches discord built-in commands', () => {
      yes('/session');
      yes('/sessions');
      yes('/new');
      yes('/model');
    });

    it('matches the model picker — Discord has one now (issue #409)', () => {
      yes('/models');
      // /model must stay distinct: `\b` sits between 'l' and 's' nowhere, so
      // the /model pattern cannot swallow /models and route it to the wrong
      // handler.
      yes('/model claude-opus-5');
    });

    it('does not match telegram-only commands', () => {
      no('/rename');
      no('/start');
      no('/help');
      no('/status');
    });

    it('does not match plain messages', () => {
      no('what is the weather');
      no('/save-note test');
    });
  });

  // ── API ───────────────────────────────────────────────────────────────────
  describe('api', () => {
    const yes = (cmd: string) => expect(isBuiltinCommand(cmd, 'api')).toBe(true);
    const no  = (cmd: string) => expect(isBuiltinCommand(cmd, 'api')).toBe(false);

    it('matches api built-in commands', () => {
      yes('/session');
      yes('/sessions');
      yes('/clear');
      yes('/compact');
      yes('/stop');
      yes('/model');
      yes('/restart');
    });

    it('does not match telegram-only commands', () => {
      no('/new');
      no('/rename');
      no('/start');
      no('/help');
      no('/status');
      no('/models');
    });

    it('does not match app-defined slash commands', () => {
      no('/save-note foo');
      no('/search bar');
    });

    it('handles trailing arguments', () => {
      yes('/stop now');
      yes('/restart');
    });
  });

  // ── Cross-channel consistency ─────────────────────────────────────────────
  describe('BUILTIN_COMMANDS registry', () => {
    it('every command has at least one channel', () => {
      for (const [cmd, def] of Object.entries(BUILTIN_COMMANDS)) {
        expect(def.channels.length).toBeGreaterThan(0);
        expect(cmd).toMatch(/^[a-z]+$/);
      }
    });

    it('every command matches on exactly the channels it declares', () => {
      // Counting channels ("commands with 3 entries are on telegram/discord/api")
      // silently mis-asserted as soon as a command gained a fourth channel or
      // took 'line' as its third. Assert the declaration itself instead.
      const allChannels = [...CHAT_CHANNELS, 'api'] as const;
      for (const [cmd, def] of Object.entries(BUILTIN_COMMANDS)) {
        for (const ch of allChannels) {
          expect({ cmd, ch, matched: isBuiltinCommand(`/${cmd}`, ch) })
            .toEqual({ cmd, ch, matched: def.channels.includes(ch) });
        }
      }
    });
  });

  // ── LINE ──────────────────────────────────────────────────────────────────
  describe('line', () => {
    it('matches the model picker and /model (issue #409)', () => {
      expect(isBuiltinCommand('/models', 'line')).toBe(true);
      expect(isBuiltinCommand('/model', 'line')).toBe(true);
      expect(isBuiltinCommand('/model claude-opus-5', 'line')).toBe(true);
    });

    it('never treats a normal message as a command', () => {
      expect(isBuiltinCommand('hi', 'line')).toBe(false);
      expect(isBuiltinCommand('สวัสดี', 'line')).toBe(false);
      expect(isBuiltinCommand('', 'line')).toBe(false);
    });

    it('does not match commands LINE has no handler for', () => {
      expect(isBuiltinCommand('/session', 'line')).toBe(true);
      expect(isBuiltinCommand('/help', 'line')).toBe(false);
    });
  });

  // Slack context commands must not capture ordinary messages or other commands.
  describe('slack', () => {
    it('never treats a normal message as a command', () => {
      expect(isBuiltinCommand('hi', 'slack')).toBe(false);
      expect(isBuiltinCommand('', 'slack')).toBe(false);
    });

    it('does not match command syntax from other channels', () => {
      expect(isBuiltinCommand('/session', 'slack')).toBe(true);
      expect(isBuiltinCommand('/models', 'slack')).toBe(false);
    });
  });
});

test.each([...CHAT_CHANNELS, 'api'] as const)('%s routes context commands without treating ordinary text as a command', channel => {
  for (const command of ['/clear', '/compact']) {
    expect(isBuiltinCommand(command, channel)).toBe(true);
    expect(isBuiltinCommand(command + 'all', channel)).toBe(false);
    expect(isBuiltinCommand('please ' + command, channel)).toBe(false);
  }
});

test.each([...CHAT_CHANNELS, 'api'] as const)('%s registers the same context commands', channel => {
  for (const command of ['/session','/sessions','/compact','/clear']) expect(isBuiltinCommand(command, channel)).toBe(true);
});
