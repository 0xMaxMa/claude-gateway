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
};

const baseGuildContext: DiscordMessageContext = {
  ...baseDMContext,
  guildId: 'guild-1',
  channelId: 'channel-1',
  isDM: false,
};

function noopSave(_a: DiscordAccess): void {}
const fixedCode = () => 'abc123';

describe('gate() — DM messages', () => {
  it('DP1: allowlisted user → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['user-1'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP2: unknown user + allowlist policy → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['other'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP3: unknown user + pairing policy → pair with code', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'pairing' };
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
      dmPolicy: 'pairing',
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
      dmPolicy: 'pairing',
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
      dmPolicy: 'pairing',
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

  it('DP8: allowlisted user with pairing policy → deliver (bypass pairing)', () => {
    const access: DiscordAccess = { ...defaultAccess(), dmPolicy: 'pairing', allowFrom: ['user-1'] };
    const result = gate(access, baseDMContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });
});

describe('gate() — guild messages', () => {
  it('DP9: guild message with empty allowlists → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: [], channelAllowlist: [] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP10: guild in allowlist → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['guild-1'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP11: guild NOT in allowlist → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), guildAllowlist: ['other-guild'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('drop');
  });

  it('DP12: channel in channelAllowlist → deliver', () => {
    const access: DiscordAccess = { ...defaultAccess(), channelAllowlist: ['channel-1'] };
    const result = gate(access, baseGuildContext, noopSave, fixedCode);
    expect(result.action).toBe('deliver');
  });

  it('DP13: channel NOT in channelAllowlist → drop', () => {
    const access: DiscordAccess = { ...defaultAccess(), channelAllowlist: ['other-channel'] };
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
      dmPolicy: 'pairing',
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
      dmPolicy: 'pairing',
      allowFrom: ['user-1', 'user-2'],
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
