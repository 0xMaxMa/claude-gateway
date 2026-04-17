import { checkAccess, buildAccessConfig } from '../../../mcp/tools/discord/access';
import type { DiscordAccessConfig, DiscordMessageContext } from '../../../mcp/tools/discord/types';

const baseGuildContext: DiscordMessageContext = {
  guildId: 'guild-1',
  channelId: 'channel-1',
  threadId: null,
  userId: 'user-1',
  username: 'testuser',
  messageId: 'msg-1',
  isDM: false,
  isThread: false,
};

const baseDMContext: DiscordMessageContext = {
  ...baseGuildContext,
  guildId: null,
  isDM: true,
};

const openConfig: DiscordAccessConfig = {
  dmPolicy: 'open',
  dmAllowlist: [],
  guildAllowlist: [],
  channelAllowlist: [],
  roleAllowlist: [],
};

describe('checkAccess', () => {
  it('DA1: DM with dmPolicy open → allowed', () => {
    const result = checkAccess({ ...openConfig, dmPolicy: 'open' }, baseDMContext);
    expect(result.allowed).toBe(true);
  });

  it('DA2: DM with dmPolicy disabled → rejected', () => {
    const result = checkAccess({ ...openConfig, dmPolicy: 'disabled' }, baseDMContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DM disabled');
  });

  it('DA3: DM with dmPolicy allowlist, user in list → allowed', () => {
    const result = checkAccess(
      { ...openConfig, dmPolicy: 'allowlist', dmAllowlist: ['user-1'] },
      baseDMContext,
    );
    expect(result.allowed).toBe(true);
  });

  it('DA4: DM with dmPolicy allowlist, user NOT in list → rejected', () => {
    const result = checkAccess(
      { ...openConfig, dmPolicy: 'allowlist', dmAllowlist: ['other-user'] },
      baseDMContext,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DM allowlist');
  });

  it('DA5: guild message, guild in allowlist → allowed', () => {
    const result = checkAccess(
      { ...openConfig, guildAllowlist: ['guild-1'] },
      baseGuildContext,
    );
    expect(result.allowed).toBe(true);
  });

  it('DA6: guild message, guild NOT in allowlist → rejected', () => {
    const result = checkAccess(
      { ...openConfig, guildAllowlist: ['other-guild'] },
      baseGuildContext,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('guild not allowed');
  });

  it('DA7: channel not in channel allowlist → rejected', () => {
    const result = checkAccess(
      { ...openConfig, channelAllowlist: ['other-channel'] },
      baseGuildContext,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('channel not allowed');
  });

  it('DA8: user has required role → allowed', () => {
    const result = checkAccess(
      { ...openConfig, roleAllowlist: ['role-admin'] },
      baseGuildContext,
      ['role-admin', 'role-member'],
    );
    expect(result.allowed).toBe(true);
  });

  it('DA9: user missing required role → rejected', () => {
    const result = checkAccess(
      { ...openConfig, roleAllowlist: ['role-admin'] },
      baseGuildContext,
      ['role-member'],
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('missing required role');
  });

  it('DA10: wildcard * in DM allowlist → allowed for all', () => {
    const result = checkAccess(
      { ...openConfig, dmPolicy: 'allowlist', dmAllowlist: ['*'] },
      baseDMContext,
    );
    expect(result.allowed).toBe(true);
  });
});

describe('buildAccessConfig', () => {
  it('reads env vars correctly', () => {
    const env: Partial<NodeJS.ProcessEnv> = {
      DISCORD_DM_POLICY: 'allowlist',
      DISCORD_DM_ALLOWLIST: 'user-1,user-2',
      DISCORD_GUILD_ALLOWLIST: 'guild-1',
      DISCORD_CHANNEL_ALLOWLIST: '',
      DISCORD_ROLE_ALLOWLIST: 'role-admin',
    };
    const config = buildAccessConfig(env as NodeJS.ProcessEnv);
    expect(config.dmPolicy).toBe('allowlist');
    expect(config.dmAllowlist).toEqual(['user-1', 'user-2']);
    expect(config.guildAllowlist).toEqual(['guild-1']);
    expect(config.channelAllowlist).toEqual([]);
    expect(config.roleAllowlist).toEqual(['role-admin']);
  });

  it('defaults dmPolicy to disabled', () => {
    const config = buildAccessConfig({} as NodeJS.ProcessEnv);
    expect(config.dmPolicy).toBe('disabled');
  });
});
