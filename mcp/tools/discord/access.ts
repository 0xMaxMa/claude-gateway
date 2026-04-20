/**
 * Discord access control — openclaw pattern from allow-list.ts + dm-command-auth.ts.
 * Pure logic, no discord.js dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { DiscordAccessConfig, DiscordMessageContext, DiscordAccess, DiscordGateResult } from './types';
export type { DiscordAccessConfig, DiscordAccess } from './types';

export type AccessResult = { allowed: boolean; reason?: string };

// ---------------------------------------------------------------------------
// File-based access (new — pairing flow)
// ---------------------------------------------------------------------------

export function defaultAccess(): DiscordAccess {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    guildAllowlist: [],
    channelAllowlist: [],
    roleAllowlist: [],
    pending: {},
  };
}

export function loadAccess(stateDir: string): DiscordAccess {
  const accessFile = path.join(stateDir, 'access.json');
  try {
    const raw = fs.readFileSync(accessFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DiscordAccess>;
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      guildAllowlist: parsed.guildAllowlist ?? [],
      channelAllowlist: parsed.channelAllowlist ?? [],
      roleAllowlist: parsed.roleAllowlist ?? [],
      pending: parsed.pending ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Seed from env vars for backward compat
      return {
        dmPolicy: (process.env.DISCORD_DM_POLICY as DiscordAccess['dmPolicy']) ?? 'pairing',
        allowFrom: process.env.DISCORD_DM_ALLOWLIST
          ? process.env.DISCORD_DM_ALLOWLIST.split(',').filter(Boolean)
          : [],
        guildAllowlist: process.env.DISCORD_GUILD_ALLOWLIST
          ? process.env.DISCORD_GUILD_ALLOWLIST.split(',').filter(Boolean)
          : [],
        channelAllowlist: process.env.DISCORD_CHANNEL_ALLOWLIST
          ? process.env.DISCORD_CHANNEL_ALLOWLIST.split(',').filter(Boolean)
          : [],
        roleAllowlist: process.env.DISCORD_ROLE_ALLOWLIST
          ? process.env.DISCORD_ROLE_ALLOWLIST.split(',').filter(Boolean)
          : [],
        pending: {},
      };
    }
    try {
      fs.renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`);
    } catch {}
    return defaultAccess();
  }
}

export function saveAccess(stateDir: string, access: DiscordAccess): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const accessFile = path.join(stateDir, 'access.json');
  const tmp = accessFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, accessFile);
}

export function pruneExpired(access: DiscordAccess, now?: number): boolean {
  const ts = now ?? Date.now();
  let changed = false;
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < ts) {
      delete access.pending[code];
      changed = true;
    }
  }
  return changed;
}

export function gate(
  access: DiscordAccess,
  context: DiscordMessageContext,
  saveAccessFn: (a: DiscordAccess) => void,
  generateCode: () => string = () => randomBytes(3).toString('hex'),
  now?: number,
): DiscordGateResult {
  const ts = now ?? Date.now();
  const pruned = pruneExpired(access, ts);
  if (pruned) saveAccessFn(access);

  const { isDM, userId, guildId, channelId } = context;

  if (!isDM) {
    if (access.guildAllowlist.length > 0 && guildId) {
      if (!access.guildAllowlist.includes(guildId)) return { action: 'drop' };
    }
    if (access.channelAllowlist.length > 0) {
      if (!access.channelAllowlist.includes(channelId)) return { action: 'drop' };
    }
    return { action: 'deliver' };
  }

  // DM message
  if (access.dmPolicy === 'disabled') return { action: 'drop' };

  if (access.allowFrom.includes(userId)) return { action: 'deliver' };
  if (access.dmPolicy === 'allowlist') return { action: 'drop' };

  // pairing mode
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === userId) {
      if (p.replies >= 2) return { action: 'drop' };
      p.replies++;
      saveAccessFn(access);
      return { action: 'pair', code, isResend: true };
    }
  }
  if (Object.keys(access.pending).length >= 3) return { action: 'drop' };

  const code = generateCode();
  access.pending[code] = {
    senderId: userId,
    channelId,
    createdAt: ts,
    expiresAt: ts + 60 * 60 * 1000,
    replies: 1,
  };
  saveAccessFn(access);
  return { action: 'pair', code, isResend: false };
}

// ---------------------------------------------------------------------------
// Env-var based access (backward compat)
// ---------------------------------------------------------------------------

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
