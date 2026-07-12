/**
 * Tests for Discord pairing flow: gate(), loadAccess(), saveAccess(), pruneExpired().
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gate,
  loadAccess,
  saveAccess,
  pruneExpired,
  defaultAccess,
  migrateAccess,
} from '../../../mcp/tools/discord/access';
import type { DiscordAccess, DiscordMessageContext } from '../../../mcp/tools/discord/types';

const baseDMContext: DiscordMessageContext = {
  guildId: null,
  channelId: 'dm-channel-1',
  threadId: null,
  userId: 'user-1',
  username: 'testuser',
  messageId: 'msg-1',
  isDM: true,
  isThread: false,
  mentionsBot: false,
};

const baseGuildContext: DiscordMessageContext = {
  ...baseDMContext,
  guildId: 'guild-1',
  channelId: 'channel-1',
  isDM: false,
  // Most guild-deliver tests assume the bot was addressed; opt in by default and
  // override to false in the requireMention-drop cases.
  mentionsBot: true,
};

function noopSave(_a: DiscordAccess): void {}
const fixedCode = () => 'abc123';

describe('gate() — DM messages', () => {
  it('DP1: allowlisted user → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['user-1'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP2: unknown user + allowlist + pairing OFF → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', pairing: false, allowFrom: ['other'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP3: unknown user + allowlist + pairing ON → pair with code', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', pairing: true };
    let saved: DiscordAccess | null = null;
    const result = gate(access, baseDMContext, (a) => { saved = { ...a, pending: { ...a.pending } }; }, fixedCode);
    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.code).toBe('abc123');
      expect(result.isResend).toBe(false);
    }
    expect(saved).not.toBeNull();
    expect(saved!.pending['abc123']).toBeDefined();
    expect(saved!.pending['abc123'].senderId).toBe('user-1');
  });

  it('DP4: same user DMs again → isResend=true', () => {
    const access: DiscordAccess = {
      ...defaultAccess(),
      dmPolicy: 'allowlist',
      pairing: true,
      pending: {
        abc123: { senderId: 'user-1', channelId: 'dm-channel-1', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
      },
    };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.isResend).toBe(true);
      expect(result.code).toBe('abc123');
    }
  });

  it('DP5: drop after 2 replies to same code', () => {
    const access: DiscordAccess = {
      ...defaultAccess(),
      dmPolicy: 'allowlist',
      pairing: true,
      pending: {
        abc123: { senderId: 'user-1', channelId: 'dm-channel-1', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 2 },
      },
    };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP6: drop when pending cap (3) reached for different users', () => {
    const access: DiscordAccess = {
      ...defaultAccess(),
      dmPolicy: 'allowlist',
      pairing: true,
      pending: {
        code1: { senderId: 'other-1', channelId: 'ch1', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
        code2: { senderId: 'other-2', channelId: 'ch2', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
        code3: { senderId: 'other-3', channelId: 'ch3', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
      },
    };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP7: disabled dmPolicy → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'disabled' };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP8: allowlisted user with pairing ON → deliver (bypass pairing)', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', pairing: true, allowFrom: ['user-1'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP8b: open policy → deliver and auto-add unknown sender to allowFrom', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'open', allowFrom: [] };
    let saved: DiscordAccess | null = null;
    const result = gate(access, baseDMContext, (a) => { saved = { ...a, allowFrom: [...a.allowFrom] }; }, fixedCode);
    expect(result.action).toBe('deliver');
    expect(saved).not.toBeNull();
    expect(saved!.allowFrom).toContain('user-1');
  });
});

describe('gate() — guild messages', () => {
  it('DP9: unknown guild + groupPolicy allowlist + pairing ON → pair (guild knock)', () => {
    const access: DiscordAccess = { ...defaultAccess(), groupPolicy: 'allowlist', pairing: true, guildAllowlist: [] };
    let saved: DiscordAccess | null = null;
    const result = gate(access, baseGuildContext, (a) => { saved = { ...a, pending: { ...a.pending } }; }, fixedCode);
    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.isGuild).toBe(true);
      expect(result.isResend).toBe(false);
    }
    expect(saved!.pending['abc123'].kind).toBe('guild');
    expect(saved!.pending['abc123'].guildId).toBe('guild-1');
  });

  it('DP9b: unknown guild + pairing OFF → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), groupPolicy: 'allowlist', pairing: false, guildAllowlist: [] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP9c: same guild knocks again → isResend=true', () => {
    const access: DiscordAccess = {
      ...defaultAccess(),
      groupPolicy: 'allowlist',
      pairing: true,
      pending: {
        gcode: { senderId: 'user-9', channelId: 'channel-1', guildId: 'guild-1', kind: 'guild', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
      },
    };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.isResend).toBe(true);
      expect(result.code).toBe('gcode');
    }
  });

  it('DP10: guild in allowlist + mentioned → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['guild-1'], requireMention: true };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP10b: guild in allowlist + requireMention + NOT mentioned → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['guild-1'], requireMention: true };
    const result = gate(access, { ...baseGuildContext, mentionsBot: false }, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP10c: guild in allowlist + requireMention:false → deliver without mention', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['guild-1'], requireMention: false };
    const result = gate(access, { ...baseGuildContext, mentionsBot: false }, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP11: groupPolicy disabled → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), groupPolicy: 'disabled', guildAllowlist: ['guild-1'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP12: groupPolicy open + mentioned → deliver (channel filter passes)', () => {
    const access: DiscordAccess = { ...defaultAccess(), groupPolicy: 'open', requireMention: true, channelAllowlist: ['channel-1'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP13: allowlisted guild but channel NOT in channelAllowlist → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['guild-1'], requireMention: false, channelAllowlist: ['other-channel'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });
});

describe('pruneExpired()', () => {
  it('DP14: removes expired pending codes', () => {
    const past = Date.now() - 1000;
    const access: DiscordAccess = {
      ...defaultAccess(),
      pending: {
        expired1: { senderId: 'u1', channelId: 'c1', createdAt: past - 3600_000, expiresAt: past, replies: 1 },
        valid1: { senderId: 'u2', channelId: 'c2', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
      },
    };
    const changed = pruneExpired(access);
    expect(changed).toBe(true);
    expect(access.pending['expired1']).toBeUndefined();
    expect(access.pending['valid1']).toBeDefined();
  });

  it('DP15: returns false when nothing to prune', () => {
    const access: DiscordAccess = {
      ...defaultAccess(),
      pending: {
        code1: { senderId: 'u1', channelId: 'c1', createdAt: Date.now(), expiresAt: Date.now() + 3600_000, replies: 1 },
      },
    };
    const changed = pruneExpired(access);
    expect(changed).toBe(false);
  });

  it('DP16: gate() prunes expired codes before deciding', () => {
    const past = Date.now() - 1000;
    // 3 pending but all expired → gate() should prune them and then create new code
    const access: DiscordAccess = {
      ...defaultAccess(),
      dmPolicy: 'allowlist',
      pairing: true,
      pending: {
        code1: { senderId: 'other-1', channelId: 'c1', createdAt: past - 3600_000, expiresAt: past, replies: 1 },
        code2: { senderId: 'other-2', channelId: 'c2', createdAt: past - 3600_000, expiresAt: past, replies: 1 },
        code3: { senderId: 'other-3', channelId: 'c3', createdAt: past - 3600_000, expiresAt: past, replies: 1 },
      },
    };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('pair');
  });
});

describe('loadAccess() / saveAccess()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DP17: round-trips access.json correctly', () => {
    const access: DiscordAccess = {
      dmPolicy: 'allowlist',
      pairing: true,
      allowFrom: ['user-1', 'user-2'],
      groupPolicy: 'allowlist',
      requireMention: true,
      guildAllowlist: ['guild-1'],
      channelAllowlist: [],
      roleAllowlist: ['role-admin'],
      pending: {
        abc123: { senderId: 'u1', channelId: 'c1', createdAt: 1000, expiresAt: 5000, replies: 1 },
      },
    };
    saveAccess(tmpDir, access);
    const loaded = loadAccess(tmpDir);
    expect(loaded).toEqual(access);
  });

  it('DP18: returns seeded default when no access.json exists', () => {
    const loaded = loadAccess(tmpDir);
    expect(loaded.pending).toEqual({});
    expect(Array.isArray(loaded.allowFrom)).toBe(true);
  });

  it('DP19: file is written with mode 0o600', () => {
    saveAccess(tmpDir, defaultAccess());
    const stat = fs.statSync(path.join(tmpDir, 'access.json'));
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('defaultAccess()', () => {
  it('DP20: new agent is allowlist + pairing ON (owner can self-pair)', () => {
    const a = defaultAccess();
    expect(a.dmPolicy).toBe('allowlist');
    expect(a.pairing).toBe(true);
    expect(a.allowFrom).toEqual([]);
    expect(a.pending).toEqual({});
  });

  it('DP20b: new agent guild tier is secure (allowlist + requireMention ON)', () => {
    const a = defaultAccess();
    expect(a.groupPolicy).toBe('allowlist');
    expect(a.requireMention).toBe(true);
    expect(a.guildAllowlist).toEqual([]);
  });
});

describe('migrateAccess()', () => {
  it('DP21: legacy dmPolicy "pairing" → allowlist + pairing ON', () => {
    const a = migrateAccess({ dmPolicy: 'pairing', allowFrom: ['u1'] });
    expect(a.dmPolicy).toBe('allowlist');
    expect(a.pairing).toBe(true);
    expect(a.allowFrom).toEqual(['u1']);
  });

  it('DP22: legacy locked allowlist (absent pairing) → pairing OFF (stays locked)', () => {
    const a = migrateAccess({ dmPolicy: 'allowlist', allowFrom: ['u1'] });
    expect(a.dmPolicy).toBe('allowlist');
    expect(a.pairing).toBe(false);
  });

  it('DP23: explicit split shape is preserved', () => {
    const a = migrateAccess({ dmPolicy: 'allowlist', pairing: true, allowFrom: [] });
    expect(a.dmPolicy).toBe('allowlist');
    expect(a.pairing).toBe(true);
  });

  it('DP24: disabled and open are carried through with pairing default OFF', () => {
    expect(migrateAccess({ dmPolicy: 'disabled' }).dmPolicy).toBe('disabled');
    expect(migrateAccess({ dmPolicy: 'open' }).dmPolicy).toBe('open');
    expect(migrateAccess({ dmPolicy: 'open' }).pairing).toBe(false);
  });

  it('DP25: absent dmPolicy → allowlist + pairing OFF', () => {
    const a = migrateAccess({});
    expect(a.dmPolicy).toBe('allowlist');
    expect(a.pairing).toBe(false);
  });

  it('DP26: existing file with empty guildAllowlist → groupPolicy open + requireMention OFF (behavior-preserving)', () => {
    const a = migrateAccess({ dmPolicy: 'allowlist', guildAllowlist: [] });
    expect(a.groupPolicy).toBe('open');
    expect(a.requireMention).toBe(false);
  });

  it('DP27: existing file with non-empty guildAllowlist → groupPolicy allowlist + requireMention OFF', () => {
    const a = migrateAccess({ dmPolicy: 'allowlist', guildAllowlist: ['guild-1'] });
    expect(a.groupPolicy).toBe('allowlist');
    expect(a.requireMention).toBe(false);
    expect(a.guildAllowlist).toEqual(['guild-1']);
  });

  it('DP28: explicit group fields are preserved', () => {
    const a = migrateAccess({ dmPolicy: 'allowlist', groupPolicy: 'disabled', requireMention: true, guildAllowlist: [] });
    expect(a.groupPolicy).toBe('disabled');
    expect(a.requireMention).toBe(true);
  });
});
