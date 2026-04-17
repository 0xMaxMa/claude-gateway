/**
 * Discord access control — openclaw pattern from allow-list.ts + dm-command-auth.ts.
 * Pure logic, no discord.js dependency.
 */

import type { DiscordAccessConfig, DiscordMessageContext } from './types';
export type { DiscordAccessConfig } from './types';

export type AccessResult = { allowed: boolean; reason?: string };

export function checkAccess(
  config: DiscordAccessConfig,
  context: DiscordMessageContext,
  memberRoles?: string[],
): AccessResult {
  if (context.isDM) {
    if (config.dmPolicy === 'disabled') return { allowed: false, reason: 'DM disabled' };
    if (config.dmPolicy === 'allowlist') {
      if (
        !config.dmAllowlist.includes(context.userId) &&
        !config.dmAllowlist.includes('*')
      ) {
        return { allowed: false, reason: 'user not in DM allowlist' };
      }
    }
    return { allowed: true };
  }

  if (config.guildAllowlist.length && context.guildId) {
    if (!config.guildAllowlist.includes(context.guildId)) {
      return { allowed: false, reason: 'guild not allowed' };
    }
  }

  if (config.channelAllowlist.length) {
    if (!config.channelAllowlist.includes(context.channelId)) {
      return { allowed: false, reason: 'channel not allowed' };
    }
  }

  if (config.roleAllowlist.length && memberRoles) {
    const hasRole = memberRoles.some(r => config.roleAllowlist.includes(r));
    if (!hasRole) return { allowed: false, reason: 'missing required role' };
  }

  return { allowed: true };
}

export function buildAccessConfig(env: NodeJS.ProcessEnv = process.env): DiscordAccessConfig {
  return {
    dmPolicy: (env.DISCORD_DM_POLICY as DiscordAccessConfig['dmPolicy']) ?? 'disabled',
    dmAllowlist: env.DISCORD_DM_ALLOWLIST ? env.DISCORD_DM_ALLOWLIST.split(',').filter(Boolean) : [],
    guildAllowlist: env.DISCORD_GUILD_ALLOWLIST
      ? env.DISCORD_GUILD_ALLOWLIST.split(',').filter(Boolean)
      : [],
    channelAllowlist: env.DISCORD_CHANNEL_ALLOWLIST
      ? env.DISCORD_CHANNEL_ALLOWLIST.split(',').filter(Boolean)
      : [],
    roleAllowlist: env.DISCORD_ROLE_ALLOWLIST
      ? env.DISCORD_ROLE_ALLOWLIST.split(',').filter(Boolean)
      : [],
  };
}
