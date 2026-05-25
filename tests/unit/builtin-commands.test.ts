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

    it('does not match telegram-only commands', () => {
      no('/rename');
      no('/start');
      no('/help');
      no('/status');
      no('/models');
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

    it('shared commands match on all three channels', () => {
      const sharedCmds = Object.entries(BUILTIN_COMMANDS)
        .filter(([, def]) => def.channels.length === 3)
        .map(([cmd]) => `/${cmd}`);

      for (const cmd of sharedCmds) {
        expect(isBuiltinCommand(cmd, 'telegram')).toBe(true);
        expect(isBuiltinCommand(cmd, 'discord')).toBe(true);
        expect(isBuiltinCommand(cmd, 'api')).toBe(true);
      }
    });
  });
});
