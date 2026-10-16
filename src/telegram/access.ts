import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The Telegram receiver's state directory for an agent: `<workspace>/.telegram-state`. */
export function telegramStateDir(workspace: string | undefined, agentsBase: string, agentId: string): string {
  const root = workspace
    ? (workspace.startsWith('~') ? path.join(os.homedir(), workspace.slice(1)) : workspace)
    : path.join(agentsBase, agentId, 'workspace');
  return path.join(root, '.telegram-state');
}

export type TelegramAccess = {
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  // Orthogonal pairing toggle (mirrors LINE). Meaningful only when
  // dmPolicy === 'allowlist'. Kept in sync with the runtime shape in
  // mcp/tools/telegram/pure.ts (migrateAccess).
  pairing: boolean;
  allowFrom: string[];
  // Group tier (mirrors LINE): flat allowlist + single mention gate.
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowlist: string[];
  requireMention: boolean;
  // Migration-only artifact — mirrors pure.ts Access — keep in sync. Never
  // written by any endpoint; only preserved so a pre-split group's per-user
  // restriction survives being read+written back through this API.
  legacyGroupAllowFrom?: Record<string, string[]>;
  pending: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number; kind?: 'dm' | 'group' }>;
};

/** The receiver's `access.json`, migrated to the current shape. Shared by the
 * agent settings API and the `/call` ticket route, which re-checks `allowFrom`. */
export function readTelegramAccess(stateDir: string): TelegramAccess {
  const accessFile = path.join(stateDir, 'access.json');
  try {
    const raw = fs.readFileSync(accessFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      dmPolicy?: string;
      pairing?: boolean;
      allowFrom?: string[];
      groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>;
      groupPolicy?: string;
      groupAllowlist?: string[];
      requireMention?: boolean;
      legacyGroupAllowFrom?: Record<string, string[]>;
      pending?: TelegramAccess['pending'];
    };
    // Migrate the legacy 4-value dmPolicy (pairing folded in) to the split
    // model. SECURITY: a legacy 'allowlist' file was locked down → pairing:false
    // (an absent pairing on an existing file means pre-split); 'pairing' → mint on.
    // Mirrors migrateAccess() in mcp/tools/telegram/pure.ts — keep in sync.
    const legacy = parsed.dmPolicy;
    let dmPolicy: TelegramAccess['dmPolicy'];
    let pairing: boolean;
    if (legacy === 'pairing') {
      dmPolicy = 'allowlist';
      pairing = true;
    } else {
      dmPolicy = (legacy as TelegramAccess['dmPolicy']) ?? 'allowlist';
      pairing = parsed.pairing ?? false;
    }
    // Group tier: flatten legacy per-group `groups` map to a flat allowlist,
    // behavior-preserving (groups were closed-by-default). Mirrors pure.ts.
    // A group's per-user `allowFrom` override has no flat-model equivalent,
    // but it's a real restriction — preserve it (mirrors
    // deriveLegacyGroupAllowFrom in pure.ts, keep in sync) rather than
    // silently dropping it and widening the group to every member.
    const groupAllowlist = parsed.groupAllowlist ?? Object.keys(parsed.groups ?? {});
    const groupPolicy = (parsed.groupPolicy as TelegramAccess['groupPolicy']) ?? 'allowlist';
    const requireMention = parsed.requireMention ?? true;
    let legacyGroupAllowFrom = parsed.legacyGroupAllowFrom;
    if (!legacyGroupAllowFrom && parsed.groups) {
      const derived: Record<string, string[]> = {};
      for (const [groupId, g] of Object.entries(parsed.groups)) {
        if (g.allowFrom && g.allowFrom.length > 0) derived[groupId] = [...g.allowFrom];
      }
      if (Object.keys(derived).length > 0) legacyGroupAllowFrom = derived;
    }
    return {
      dmPolicy,
      pairing,
      allowFrom: parsed.allowFrom ?? [],
      groupPolicy,
      groupAllowlist,
      requireMention,
      legacyGroupAllowFrom,
      pending: parsed.pending ?? {},
    };
  } catch {
    // Brand-new agent (no file): closed base + pairing on (capture owner id).
    return { dmPolicy: 'allowlist', pairing: true, allowFrom: [], groupPolicy: 'allowlist', groupAllowlist: [], requireMention: true, pending: {} };
  }
}
