/**
 * WhatsApp multi-account config shape — normalization, back-compat upgrade,
 * and the on-disk state-directory rule.
 *
 * Phase 1 of the WhatsApp feature-parity plan replaced `AgentConfig.whatsapp`'s
 * single flat block:
 *
 *   "whatsapp": { "dmPolicy": "allowlist", "dmAllowlist": ["…"] }
 *
 * with an array of per-number accounts:
 *
 *   "whatsapp": { "accounts": [ { "id": "default", "dmPolicy": "allowlist", … } ] }
 *
 * A gateway upgraded in place will have live config.json files (and a LIVE
 * linked Baileys session on disk) in the old shape, so:
 *
 *  1. {@link upgradeAgentWhatsAppAccounts} rewrites the old shape into the new
 *     one in memory, and {@link upgradeWhatsAppAccountsFile} writes it back so
 *     the config self-heals permanently on first load.
 *  2. The synthesized account is always `id: 'default'`, and 'default' is
 *     special-cased in {@link whatsAppStateDir} to keep using the historical
 *     BARE `<workspace>/.whatsapp-state/` directory. Nothing on disk moves, so
 *     an already-linked number stays linked across the upgrade. Only NEW
 *     accounts get a `<workspace>/.whatsapp-state/<id>/` subdirectory.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { WhatsAppAccountConfig } from '../types';

/** Reserved id of the pre-multi-account session — see the module doc above. */
export const DEFAULT_WHATSAPP_ACCOUNT_ID = 'default';

/** Bare state directory name; also the 'default' account's directory verbatim. */
export const WHATSAPP_STATE_DIR = '.whatsapp-state';

/**
 * Account ids double as on-disk directory names and as MCP `account_id`
 * values, so they're restricted to a conservative slug: lowercase
 * alphanumerics plus `-`/`_`, never a path traversal or a dotfile.
 */
export const WHATSAPP_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The legacy flat fields that get lifted onto the synthesized 'default' account. */
const LEGACY_ACCESS_FIELDS = [
  'dmPolicy',
  'dmAllowlist',
  'groupPolicy',
  'groupAllowlist',
  'requireMention',
  'pairing',
  // Phase 2 behaviour flags. They postdate the flat shape, so a genuine
  // pre-Phase-1 config never carries them — but a hand-edited config.json can
  // still have them sitting in a flat block, and lifting them costs nothing
  // (absent fields stay absent, so an untouched config still upgrades to the
  // exact same JSON it did before).
  'sendReadReceipts',
  'reactionLevel',
] as const;

/**
 * Resolve the Baileys state directory for one account.
 *
 * 'default' deliberately uses the BARE `.whatsapp-state/` path rather than
 * `.whatsapp-state/default/`: that is the directory a pre-multi-account
 * gateway already linked into, and moving it is the one operation that could
 * lose a live session. Every other account nests one level below it, which
 * cannot collide with Baileys' own files (it writes `creds.json` and
 * `<key-type>-<id>.json`, never a directory).
 */
export function whatsAppStateDir(workspace: string, accountId: string): string {
  const base = path.join(workspace, WHATSAPP_STATE_DIR);
  return accountId === DEFAULT_WHATSAPP_ACCOUNT_ID ? base : path.join(base, accountId);
}

/**
 * The accounts an agent actually runs, given its (possibly absent) config.
 *
 * An absent/empty array resolves to a lone 'default' account so an agent that
 * has never touched WhatsApp still gets a linkable manager — exactly the
 * pre-multi-account behavior, where AgentRunner constructed a WhatsAppManager
 * unconditionally because there was no config field to gate on.
 */
export function resolveWhatsAppAccounts(
  cfg: { accounts?: WhatsAppAccountConfig[] } | undefined,
): WhatsAppAccountConfig[] {
  const accounts = cfg?.accounts;
  if (Array.isArray(accounts) && accounts.length > 0) return accounts;
  return [{ id: DEFAULT_WHATSAPP_ACCOUNT_ID }];
}

/** Look up one account's config by id (undefined when it isn't configured). */
export function findWhatsAppAccount(
  cfg: { accounts?: WhatsAppAccountConfig[] } | undefined,
  accountId: string,
): WhatsAppAccountConfig | undefined {
  return resolveWhatsAppAccounts(cfg).find((a) => a.id === accountId);
}

/**
 * True when `block` is a `whatsapp` config in the OLD flat shape — i.e. an
 * object that has no `accounts` array. An empty `{}` counts as legacy (it
 * upgrades to a bare 'default' account); anything already carrying `accounts`
 * does not.
 */
export function isLegacyWhatsAppBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  return !Array.isArray((block as Record<string, unknown>).accounts);
}

/**
 * Convert an old flat `whatsapp` block into the new `{ accounts: [...] }`
 * shape, lifting every legacy access-control field onto a single account
 * whose id is 'default' (which keeps the existing on-disk session — see the
 * module doc). Absent fields stay absent rather than being materialized as
 * explicit undefineds, so the rewritten JSON stays as small as the original.
 */
export function upgradeWhatsAppBlock(block: Record<string, unknown>): {
  accounts: WhatsAppAccountConfig[];
} {
  const account: Record<string, unknown> = { id: DEFAULT_WHATSAPP_ACCOUNT_ID };
  for (const field of LEGACY_ACCESS_FIELDS) {
    if (block[field] !== undefined) account[field] = block[field];
  }
  return { accounts: [account as unknown as WhatsAppAccountConfig] };
}

/**
 * Upgrade one agent entry in place. Returns true when it was rewritten.
 * Safe to call repeatedly — an already-upgraded agent is left untouched.
 */
export function upgradeAgentWhatsAppAccounts(agent: Record<string, unknown>): boolean {
  const block = agent.whatsapp;
  if (!isLegacyWhatsAppBlock(block)) return false;
  agent.whatsapp = upgradeWhatsAppBlock(block as Record<string, unknown>);
  return true;
}

/**
 * Upgrade every agent in a parsed config object in place. Returns the ids of
 * the agents that were rewritten (empty when nothing needed upgrading).
 */
export function upgradeWhatsAppAccountsInConfig(config: Record<string, unknown>): string[] {
  const agents = config.agents;
  if (!Array.isArray(agents)) return [];
  const upgraded: string[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const entry = agent as Record<string, unknown>;
    if (upgradeAgentWhatsAppAccounts(entry)) upgraded.push(String(entry.id ?? '<unknown>'));
  }
  return upgraded;
}

/**
 * Read config.json, upgrade any legacy `whatsapp` blocks, and atomically
 * write it back so the migration is permanent (a later save from the API
 * would otherwise re-persist the old shape from whatever was last read).
 *
 * Best-effort by design: a missing/unreadable/invalid config is left alone
 * and reported as "nothing upgraded" — boot continues into loadConfig, which
 * produces the real, user-facing error for a broken config. The in-memory
 * normalization in loadConfig means runtime is correct even if this write
 * fails (e.g. read-only filesystem).
 */
export function upgradeWhatsAppAccountsFile(configPath: string): string[] {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];

  const upgraded = upgradeWhatsAppAccountsInConfig(config);
  if (upgraded.length === 0) return [];

  const tmpPath = `${configPath}.tmp.whatsapp-accounts`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, configPath);
  return upgraded;
}
