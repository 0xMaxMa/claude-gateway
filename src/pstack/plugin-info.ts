import { readFileSync } from 'fs';
import { join } from 'path';
import { claudeConfigDir } from '../config/claude-settings';

/**
 * pstack is installed once, by Claude Code itself (`/plugin install
 * pstack@pstack-claude`); the gateway keeps no copy and never writes Claude
 * Code's plugin files. It only reads where Claude Code put the plugin, to find
 * the role list in its models.json.
 */
export const PSTACK_PLUGIN_ID = 'pstack@pstack-claude';
export const PSTACK_INSTALL_HINT = `Install it with \`/plugin install ${PSTACK_PLUGIN_ID}\` in Claude Code on this host.`;

export interface PstackPluginInfo { installed: boolean; installPath?: string }

/** Read `installPath` from Claude Code's plugin registry (installed_plugins.json, v2).
 * A missing or unreadable registry means not installed. */
export function pstackPluginInfo(configDir = claudeConfigDir()): PstackPluginInfo {
  try {
    const registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries: unknown = registry?.plugins?.[PSTACK_PLUGIN_ID];
    if (!Array.isArray(entries)) return { installed: false };
    const entry = entries.find(e => e?.scope === 'user') ?? entries[0];
    return typeof entry?.installPath === 'string' && entry.installPath ? { installed: true, installPath: entry.installPath } : { installed: false };
  } catch {
    return { installed: false };
  }
}

export interface PstackModels {
  /** Role names in sheet order, each with the tier its skill defaults to. */
  roles: Array<{ role: string; models: string }>;
  /** Tier -> slug(s), e.g. default: "opus", panel: ["opus", "fable", "sonnet", "haiku"]. */
  tiers: Record<string, string | string[]>;
}

/** The installed plugin's models.json; undefined when it cannot be read. */
export function pstackModels(installPath: string): PstackModels | undefined {
  try {
    const models = JSON.parse(readFileSync(join(installPath, 'models.json'), 'utf8'));
    const roles = Array.isArray(models?.roles) ? models.roles.filter((r: unknown) =>
      typeof (r as { role?: unknown })?.role === 'string' && typeof (r as { models?: unknown }).models === 'string') : [];
    return roles.length ? { roles: roles.map((r: { role: string; models: string }) => ({ role: r.role, models: r.models })), tiers: models.tiers ?? {} } : undefined;
  } catch {
    return undefined;
  }
}
