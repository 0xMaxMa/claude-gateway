/**
 * Discord access control — openclaw pattern from allow-list.ts + dm-command-auth.ts.
 * Pure logic, no discord.js dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { DiscordAccessConfig, DiscordMessageContext, DiscordAccess, DiscordGateResult, DiscordPending } from './types';
export type { DiscordAccessConfig, DiscordAccess } from './types';

export type AccessResult = { allowed: boolean; reason?: string };

// ---------------------------------------------------------------------------
// File-based access (new — pairing flow)
// ---------------------------------------------------------------------------

// Default for a brand-new agent (no access.json yet): closed base + pairing on,
// so the owner can DM the bot and capture their own id via a code. This matches
// the pre-split behavior where a missing file defaulted to dmPolicy:'pairing'.
export function defaultAccess(): DiscordAccess {
  return {
    dmPolicy: 'allowlist',
    pairing: true,
    allowFrom: [],
    // Secure new-agent default: guilds closed + answer only when @mentioned.
    groupPolicy: 'allowlist',
    requireMention: true,
    guildAllowlist: [],
    channelAllowlist: [],
    roleAllowlist: [],
    pending: {},
  };
}

/**
 * Normalize a parsed access.json into the current split shape, migrating the
 * legacy fused dmPolicy ('pairing' folded pairing in) to the split model.
 * Mirrors telegram/pure.ts:migrateAccess.
 *
 * SECURITY: a legacy `allowlist` file was deliberately locked down — it must
 * migrate to `pairing:false`, NOT true, or it would start minting codes for
 * strangers. Here an absent `pairing` on an existing file means a pre-split
 * file → pairing off. Only the brand-new/ENOENT path (defaultAccess) is on.
 */
export function migrateAccess(parsed: {
  dmPolicy?: string;
  pairing?: boolean;
  allowFrom?: string[];
  groupPolicy?: string;
  requireMention?: boolean;
  guildAllowlist?: string[];
  channelAllowlist?: string[];
  roleAllowlist?: string[];
  pending?: Record<string, DiscordPending>;
}): DiscordAccess {
  const legacy = parsed.dmPolicy;
  let dmPolicy: DiscordAccess['dmPolicy'];
  let pairing: boolean;
  if (legacy === 'pairing') {
    dmPolicy = 'allowlist';
    pairing = true;
  } else {
    dmPolicy = (legacy as DiscordAccess['dmPolicy']) ?? 'allowlist';
    pairing = parsed.pairing ?? false;
  }
  const guildAllowlist = parsed.guildAllowlist ?? [];
  // Guild tier migration must be behavior-preserving on upgrade. Today an empty
  // guildAllowlist means "deliver to all guilds" — so derive 'open' when empty,
  // 'allowlist' when non-empty; and requireMention defaults to false for
  // existing files (they had no mention gate). New agents get the secure
  // 'allowlist'+requireMention:true from defaultAccess() instead.
  const groupPolicy = (parsed.groupPolicy as DiscordAccess['groupPolicy'])
    ?? (guildAllowlist.length > 0 ? 'allowlist' : 'open');
  const requireMention = parsed.requireMention ?? false;
  return {
    dmPolicy,
    pairing,
    allowFrom: parsed.allowFrom ?? [],
    groupPolicy,
    requireMention,
    guildAllowlist,
    channelAllowlist: parsed.channelAllowlist ?? [],
    roleAllowlist: parsed.roleAllowlist ?? [],
    pending: parsed.pending ?? {},
  };
}

export function loadAccess(stateDir: string): DiscordAccess {
  const accessFile = path.join(stateDir, 'access.json');
  try {
    const raw = fs.readFileSync(accessFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DiscordAccess> & { dmPolicy?: string };
    return migrateAccess(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Brand-new agent (no access.json yet). If the deployment configured
      // access via DISCORD_* env vars, honour that (legacy backward-compat,
      // normalized through migrate). Otherwise fall back to defaultAccess() so
      // the owner can DM the bot and self-pair — migrateAccess would yield
      // pairing:false here (its "locked existing file" rule), which wrongly
      // drops the owner's first DM on a fresh agent.
      const hasEnvConfig = Boolean(
        process.env.DISCORD_DM_POLICY ||
        process.env.DISCORD_DM_ALLOWLIST ||
        process.env.DISCORD_GUILD_ALLOWLIST ||
        process.env.DISCORD_CHANNEL_ALLOWLIST ||
        process.env.DISCORD_ROLE_ALLOWLIST,
      );
      if (!hasEnvConfig) return defaultAccess();
      return migrateAccess({
        dmPolicy: process.env.DISCORD_DM_POLICY,
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
      });
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
    if (access.groupPolicy === 'disabled') return { action: 'drop' };

    if (access.groupPolicy === 'allowlist' && guildId && !access.guildAllowlist.includes(guildId)) {
      // Unknown guild. Pairing off ⇒ silent drop. On ⇒ mint a code keyed on the
      // guild id and post it here; a member relays it to the admin (mirrors LINE).
      if (!access.pairing) return { action: 'drop' };
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.kind === 'guild' && p.guildId === guildId) {
          if (p.replies >= 2) return { action: 'drop' };
          p.replies++;
          saveAccessFn(access);
          return { action: 'pair', code, isResend: true, isGuild: true };
        }
      }
      if (countPending(access, 'guild') >= 5) return { action: 'drop' };
      const code = generateCode();
      access.pending[code] = {
        senderId: userId,
        channelId,
        guildId,
        kind: 'guild',
        createdAt: ts,
        expiresAt: ts + 60 * 60 * 1000,
        replies: 1,
      };
      saveAccessFn(access);
      return { action: 'pair', code, isResend: false, isGuild: true };
    }

    // Allowlisted (or open policy) → keep the channel filter, then mention gate.
    if (access.channelAllowlist.length > 0) {
      if (!access.channelAllowlist.includes(channelId)) return { action: 'drop' };
    }
    if (access.requireMention !== false && !context.mentionsBot) return { action: 'drop' };
    return { action: 'deliver' };
  }

  // DM message
  if (access.dmPolicy === 'disabled') return { action: 'drop' };

  if (access.dmPolicy === 'open') {
    // Open base: anyone may DM; capture their id so future messages are known.
    if (!access.allowFrom.includes(userId)) {
      access.allowFrom.push(userId);
      saveAccessFn(access);
    }
    return { action: 'deliver' };
  }

  if (access.allowFrom.includes(userId)) return { action: 'deliver' };
  // Base policy is 'allowlist' ('disabled'/'open' handled above). Pairing is the
  // orthogonal toggle: off ⇒ pure allowlist (drop strangers, no code).
  if (!access.pairing) return { action: 'drop' };

  // pairing mode
  for (const [code, p] of Object.entries(access.pending)) {
    if ((p.kind ?? 'dm') === 'dm' && p.senderId === userId) {
      if (p.replies >= 2) return { action: 'drop' };
      p.replies++;
      saveAccessFn(access);
      return { action: 'pair', code, isResend: true };
    }
  }
  // Cap pending per-kind so guild knocks and DM knocks don't starve each other.
  if (countPending(access, 'dm') >= 5) return { action: 'drop' };

  const code = generateCode();
  access.pending[code] = {
    senderId: userId,
    channelId,
    kind: 'dm',
    createdAt: ts,
    expiresAt: ts + 60 * 60 * 1000,
    replies: 1,
  };
  saveAccessFn(access);
  return { action: 'pair', code, isResend: false };
}

/** Count pending entries of a given kind (absent kind ⇒ 'dm'). */
function countPending(access: DiscordAccess, kind: 'dm' | 'guild'): number {
  let n = 0;
  for (const p of Object.values(access.pending)) {
    if ((p.kind ?? 'dm') === kind) n++;
  }
  return n;
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
