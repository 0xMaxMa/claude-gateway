import * as fs from 'fs';
import * as path from 'path';

export interface MigrationResult {
  migrated: boolean;
  addedFields: string[];
  removedFields: string[];
  warnings: string[];
}

export interface DetectMigrationResult {
  needed: boolean;
  fromVersion: string;
  toVersion: string;
  addedFields: string[];
  removedFields: string[];
  warnings: string[];
  config: Record<string, unknown>;
  template: Record<string, unknown>;
}

export interface CleanTemplateResult {
  template: Record<string, unknown>;
  ignorePaths: Set<string>;
  removePaths: string[];
}

/**
 * Deep-merge template into target, adding missing keys only.
 * Never overwrites existing values. Returns list of added field paths.
 * Keys whose full path is in ignorePaths are skipped entirely.
 */
function deepMerge(
  target: Record<string, unknown>,
  template: Record<string, unknown>,
  prefix: string,
  added: string[],
  ignorePaths?: Set<string>,
): void {
  for (const key of Object.keys(template)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    // Skip paths that are in the ignorePaths set
    if (ignorePaths && ignorePaths.has(fullPath)) {
      continue;
    }

    if (!(key in target)) {
      target[key] = structuredClone(template[key]);
      added.push(fullPath);
    } else if (
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key]) &&
      typeof template[key] === 'object' &&
      template[key] !== null &&
      !Array.isArray(template[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        template[key] as Record<string, unknown>,
        fullPath,
        added,
        ignorePaths,
      );
    }
  }
}

// Per-agent fields that are instance-specific and must never be copied from a
// template agent into user agents during migration (credentials, identity, paths).
const AGENT_CREDENTIAL_FIELDS = new Set([
  'env',
  'telegram',
  'discord',
  'workspace',
  'avatar',
  'id',
  'name',
  'description',
]);

/**
 * Merge missing fields from template agent into each user agent.
 * Uses the first agent in the template as the schema source.
 * Instance-specific fields (credentials, paths, identity) are always excluded.
 */
function mergeAgentArrays(
  userAgents: Array<Record<string, unknown>>,
  templateAgents: Array<Record<string, unknown>>,
  added: string[],
  ignorePaths?: Set<string>,
): void {
  if (templateAgents.length === 0) return;
  const schema = templateAgents[0];
  for (let i = 0; i < userAgents.length; i++) {
    const agentIgnorePaths = new Set(ignorePaths);
    for (const field of AGENT_CREDENTIAL_FIELDS) {
      agentIgnorePaths.add(`agents[${i}].${field}`);
    }
    deepMerge(userAgents[i], schema, `agents[${i}]`, added, agentIgnorePaths);
  }
}

/**
 * Remove dot-path keys from each agent entry. Returns paths actually removed.
 * Paths are relative to each agent object (e.g. "telegram.allowedUsers").
 */
function pruneAgentPaths(
  agents: Array<Record<string, unknown>>,
  removePaths: string[],
): string[] {
  const removed: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    for (const dotPath of removePaths) {
      const parts = dotPath.split('.');
      let obj: Record<string, unknown> = agent;
      let valid = true;
      for (let j = 0; j < parts.length - 1; j++) {
        if (typeof obj[parts[j]] !== 'object' || obj[parts[j]] === null) {
          valid = false;
          break;
        }
        obj = obj[parts[j]] as Record<string, unknown>;
      }
      const leaf = parts[parts.length - 1];
      if (valid && leaf in obj) {
        delete obj[leaf];
        const fullPath = `agents[${i}].${dotPath}`;
        if (!removed.includes(fullPath)) removed.push(fullPath);
      }
    }
  }
  return removed;
}

const PLACEHOLDER_RE = /^\$\{[^}]+\}$/;
// Matches ~/.claude-gateway/agents/<id>/.env — captures the agent id in the path
const AGENT_ENV_PATH_RE = /[/\\]agents[/\\]([^/\\]+)[/\\]\.env$/;

/**
 * Collect all botToken placeholder values from template agents so that
 * repairInjectedAgentFields can distinguish leaked template credentials
 * from legitimate user credentials (which also use ${VAR} format).
 *
 * Iterates all agents in the template array (typically only index 0 exists).
 * PLACEHOLDER_RE is intentional here — template configs always ship with
 * unresolved ${VAR} references, never resolved tokens.
 */
function extractTemplateCredentials(templateAgents: Array<Record<string, unknown>>): Set<string> {
  const creds = new Set<string>();
  for (const agent of templateAgents) {
    for (const ch of ['telegram', 'discord'] as const) {
      const block = agent[ch];
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        const bt = String((block as Record<string, unknown>).botToken ?? '');
        if (PLACEHOLDER_RE.test(bt)) creds.add(bt);
      }
    }
  }
  return creds;
}

/**
 * Remove fields from agents that were incorrectly injected by a prior buggy
 * migration (where the template agent's credentials leaked into user agents).
 *
 * - telegram/discord: removed only when botToken exactly matches a known template
 *   credential placeholder (e.g. "${ALFRED_BOT_TOKEN}"). User agents legitimately
 *   store their own "${AGENT_BOT_TOKEN}" placeholders which must NOT be removed.
 * - env: removed when the path references a different agent's directory.
 *
 * Returns the list of paths removed.
 */
export function repairInjectedAgentFields(
  agents: Array<Record<string, unknown>>,
  templateCredentials: Set<string>,
): string[] {
  const removed: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    // Remove channel blocks whose botToken exactly matches a template credential —
    // meaning it was leaked from the template agent into this user agent.
    if (templateCredentials.size > 0) {
      for (const channel of ['telegram', 'discord'] as const) {
        const block = agent[channel];
        if (
          block &&
          typeof block === 'object' &&
          !Array.isArray(block) &&
          templateCredentials.has(String((block as Record<string, unknown>).botToken ?? ''))
        ) {
          delete agent[channel];
          removed.push(`agents[${i}].${channel}`);
        }
      }
    }

    // Remove env paths that point to a different agent's directory
    if (typeof agent.env === 'string') {
      const match = AGENT_ENV_PATH_RE.exec(agent.env);
      if (match && match[1] !== String(agent.id ?? '')) {
        delete agent.env;
        removed.push(`agents[${i}].env`);
      }
    }
  }
  return removed;
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * `configVersion` at which the localhost-only `gateway.bind` default landed
 * (Issue #201 / PR #202, shipped in package v1.3.26). Note: `configVersion`
 * (config.json schema version, currently 1.0.x) is a SEPARATE series from the
 * package/release version (1.3.x) — the gate below compares against the
 * config schema version, not the release version.
 */
const BIND_LOCALHOST_DEFAULT_CONFIG_VERSION = '1.0.13';

/** Warning surfaced when a migration pins `gateway.bind` to preserve external access (Issue #204). */
export const BIND_PRESERVED_WARNING =
  'gateway.bind was pinned to "0.0.0.0" to preserve external API/dashboard access across this upgrade. ' +
  'Set gateway.bind to "127.0.0.1" in config.json if you do not need access from outside this host.';

/**
 * Behavior-preserving migration for `gateway.bind` (Issue #204).
 *
 * configVersion 1.0.13 (package v1.3.26, #201/#202) made the server default to
 * binding 127.0.0.1 when `gateway.bind` is unset. Configs written before that
 * schema version were implicitly bound to 0.0.0.0, so silently applying the new
 * localhost default cuts off external API/dashboard access with no warning. To
 * preserve prior behavior, pin `bind` to "0.0.0.0" for configs older than
 * 1.0.13 that never set it. Fresh installs (no prior config, so no migration
 * runs) keep the secure localhost default.
 *
 * Mutates `config` in place when it pins the value. Returns the added field
 * path (`gateway.bind`) if pinned, otherwise null.
 */
function preserveBindDefault(
  config: Record<string, unknown>,
  fromVersion: string,
): string | null {
  // Only configs older than the localhost-default schema version were bound to all interfaces.
  if (compareSemver(fromVersion, BIND_LOCALHOST_DEFAULT_CONFIG_VERSION) >= 0) return null;

  const gateway = config.gateway;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) return null;

  const g = gateway as Record<string, unknown>;
  // Respect any explicit bind the user already set — never overwrite.
  if ('bind' in g) return null;

  g.bind = '0.0.0.0';
  return 'gateway.bind';
}

/**
 * Load a template file, extract the _migration metadata, strip it,
 * and return the clean template along with the ignorePaths set.
 */
export function loadCleanTemplate(templatePath: string): CleanTemplateResult {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Config template not found at "${templatePath}". Cannot load.`);
  }

  const templateRaw = fs.readFileSync(templatePath, 'utf-8');
  const template = JSON.parse(templateRaw) as Record<string, unknown>;

  // Extract ignorePaths and removePaths from _migration metadata
  let ignorePaths = new Set<string>();
  let removePaths: string[] = [];
  if (
    template._migration &&
    typeof template._migration === 'object' &&
    !Array.isArray(template._migration)
  ) {
    const migration = template._migration as Record<string, unknown>;
    if (Array.isArray(migration.ignorePaths)) {
      ignorePaths = new Set(
        (migration.ignorePaths as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        ),
      );
    }
    if (Array.isArray(migration.removePaths)) {
      removePaths = (migration.removePaths as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      );
    }
  }

  // Strip _migration from the template
  delete template._migration;

  return { template, ignorePaths, removePaths };
}

/**
 * Recursively delete keys from obj whose full dotted path matches any entry
 * in ignorePaths. The prefix parameter tracks the current path during recursion.
 */
export function stripIgnoredPaths(
  obj: Record<string, unknown>,
  ignorePaths: Set<string>,
  prefix = '',
): void {
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (ignorePaths.has(fullPath)) {
      delete obj[key];
    } else if (
      typeof obj[key] === 'object' &&
      obj[key] !== null &&
      !Array.isArray(obj[key])
    ) {
      stripIgnoredPaths(obj[key] as Record<string, unknown>, ignorePaths, fullPath);
    }
  }
}

/**
 * Detect whether a config migration is needed (dry-run, no writes).
 * Returns migration metadata including the fields that would be added.
 */
export function detectMigration(
  configPath: string,
  templatePath: string,
  templateVersion: string,
): DetectMigrationResult {
  const noMigration = (
    config: Record<string, unknown>,
    template: Record<string, unknown>,
    fromVersion: string,
  ): DetectMigrationResult => ({
    needed: false,
    fromVersion,
    toVersion: templateVersion,
    addedFields: [],
    removedFields: [],
    warnings: [],
    config,
    template,
  });

  // Config file missing = first run, create-agent handles it
  if (!fs.existsSync(configPath)) {
    return noMigration({}, {}, '0.0.0');
  }

  // Template must exist — load and strip _migration
  const { template, ignorePaths, removePaths } = loadCleanTemplate(templatePath);

  // Read and parse config
  let configRaw: string;
  try {
    configRaw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file: ${(err as Error).message}`);
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  // Version check
  const configVersion = (config.configVersion as string) ?? '0.0.0';
  if (compareSemver(configVersion, templateVersion) >= 0) {
    return noMigration(config, template, configVersion);
  }

  // Dry-run merge on a clone to detect what would be added/removed
  const configClone = structuredClone(config);
  const added: string[] = [];
  const warnings: string[] = [];

  // Preserve external bind behavior for pre-1.0.13 configs (Issue #204) BEFORE
  // the template merge — mirrors applyMigration so the dry-run reports the same
  // gateway.bind = "0.0.0.0" instead of the template's localhost default.
  const bindField = preserveBindDefault(configClone, configVersion);
  if (bindField) {
    added.push(bindField);
    warnings.push(BIND_PRESERVED_WARNING);
  }

  // Deep-merge top-level keys (except agents which need special handling)
  const templateWithoutAgents = { ...template };
  delete templateWithoutAgents.agents;
  deepMerge(configClone, templateWithoutAgents, '', added, ignorePaths);

  // Migrate models array by ID
  migrateModels(configClone, template, added);

  // Merge agent arrays
  if (Array.isArray(configClone.agents) && Array.isArray(template.agents)) {
    mergeAgentArrays(
      configClone.agents as Array<Record<string, unknown>>,
      template.agents as Array<Record<string, unknown>>,
      added,
      ignorePaths,
    );
  }

  // Prune removed paths from agent entries
  const removed: string[] = [];
  if (removePaths.length > 0 && Array.isArray(configClone.agents)) {
    removed.push(
      ...pruneAgentPaths(configClone.agents as Array<Record<string, unknown>>, removePaths),
    );
  }

  // Repair credential fields that were incorrectly injected by earlier buggy migrations
  if (Array.isArray(configClone.agents)) {
    const templateCreds = extractTemplateCredentials(
      (template.agents as Array<Record<string, unknown>>) ?? [],
    );
    removed.push(
      ...repairInjectedAgentFields(
        configClone.agents as Array<Record<string, unknown>>,
        templateCreds,
      ),
    );
  }

  // configVersion will always be updated
  if (!added.includes('configVersion')) {
    added.push('configVersion');
  }

  return {
    needed: true,
    fromVersion: configVersion,
    toVersion: templateVersion,
    addedFields: added,
    removedFields: removed,
    warnings,
    config,
    template,
  };
}

/**
 * Apply a config migration: deep-merge missing fields, update version,
 * create backup, and write the updated config.
 */
export function applyMigration(
  configPath: string,
  config: Record<string, unknown>,
  template: Record<string, unknown>,
  templateVersion: string,
  ignorePaths?: Set<string>,
  removePaths?: string[],
): MigrationResult {
  const added: string[] = [];
  const warnings: string[] = [];

  // Capture the pre-migration version before configVersion is overwritten below.
  const fromVersion = (config.configVersion as string) ?? '0.0.0';

  // Preserve external bind behavior for pre-1.0.13 configs (Issue #204) BEFORE
  // the template merge: config.template.json ships gateway.bind = "127.0.0.1",
  // and deepMerge would inject that localhost default into a config that never
  // set bind. Pinning here first means deepMerge (which only adds missing keys)
  // leaves our 0.0.0.0 untouched, so old deployments keep external access.
  const bindField = preserveBindDefault(config, fromVersion);
  if (bindField) {
    added.push(bindField);
    warnings.push(BIND_PRESERVED_WARNING);
  }

  // Deep-merge top-level keys (except agents)
  const templateWithoutAgents = { ...template };
  delete templateWithoutAgents.agents;
  deepMerge(config, templateWithoutAgents, '', added, ignorePaths);

  // Migrate models array by ID
  migrateModels(config, template, added);

  // Merge agent arrays
  if (Array.isArray(config.agents) && Array.isArray(template.agents)) {
    mergeAgentArrays(
      config.agents as Array<Record<string, unknown>>,
      template.agents as Array<Record<string, unknown>>,
      added,
      ignorePaths,
    );
  }

  // Prune removed paths from agent entries
  const removed: string[] = [];
  if (removePaths && removePaths.length > 0 && Array.isArray(config.agents)) {
    removed.push(
      ...pruneAgentPaths(config.agents as Array<Record<string, unknown>>, removePaths),
    );
  }

  // Repair credential fields that were incorrectly injected by earlier buggy migrations
  if (Array.isArray(config.agents)) {
    const templateCreds = extractTemplateCredentials(
      (template.agents as Array<Record<string, unknown>>) ?? [],
    );
    removed.push(
      ...repairInjectedAgentFields(
        config.agents as Array<Record<string, unknown>>,
        templateCreds,
      ),
    );
  }

  // Update configVersion
  config.configVersion = templateVersion;
  if (!added.includes('configVersion')) {
    added.push('configVersion');
  }

  // Backup before writing
  const backupPath = configPath + '.bak';
  fs.copyFileSync(configPath, backupPath);

  // Write atomically via temp file
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, configPath);

  return { migrated: true, addedFields: added, removedFields: removed, warnings };
}

/**
 * Migrate config.json by adding missing fields from the template.
 * - Never overwrites existing values
 * - Creates a .bak backup before writing
 * - Skips migration if config file does not exist (first run)
 */
export function migrateConfig(
  configPath: string,
  templatePath: string,
  templateVersion: string,
): MigrationResult {
  const detection = detectMigration(configPath, templatePath, templateVersion);

  if (!detection.needed) {
    return { migrated: false, addedFields: [], removedFields: [], warnings: [] };
  }

  // Load ignorePaths and removePaths again for the actual merge
  let ignorePaths: Set<string> | undefined;
  let removePaths: string[] | undefined;
  try {
    const clean = loadCleanTemplate(templatePath);
    ignorePaths = clean.ignorePaths;
    removePaths = clean.removePaths;
  } catch {
    // If template can't be loaded again, proceed without ignorePaths/removePaths
  }

  return applyMigration(
    configPath,
    detection.config,
    detection.template,
    templateVersion,
    ignorePaths,
    removePaths,
  );
}

/**
 * Merge models from template into user config by ID.
 * Adds new models, updates alias/label/contextWindow of existing ones.
 * Preserves user models not in template.
 */
function migrateModels(
  config: Record<string, unknown>,
  template: Record<string, unknown>,
  added: string[],
): void {
  const gw = config.gateway as Record<string, unknown> | undefined;
  const tgw = template.gateway as Record<string, unknown> | undefined;
  if (!gw || !tgw) return;

  const templateModels = tgw.models as Array<Record<string, unknown>> | undefined;
  if (!templateModels || templateModels.length === 0) return;

  const userModels = (gw.models ?? []) as Array<Record<string, unknown>>;
  const userMap = new Map(userModels.map((m) => [m.id as string, m]));
  const merged: Array<Record<string, unknown>> = [];

  for (const tm of templateModels) {
    const existing = userMap.get(tm.id as string);
    if (existing) {
      existing.alias = tm.alias;
      existing.label = tm.label;
      existing.contextWindow = tm.contextWindow;
      merged.push(existing);
    } else {
      merged.push(structuredClone(tm));
      added.push(`gateway.models[${tm.id}]`);
    }
  }

  for (const um of userModels) {
    if (!templateModels.some((tm) => tm.id === um.id)) {
      merged.push(um);
    }
  }

  gw.models = merged;
}

// Exported for testing
export { compareSemver, deepMerge, migrateModels, pruneAgentPaths, AGENT_CREDENTIAL_FIELDS };
