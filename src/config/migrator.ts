import * as fs from 'fs';
import * as path from 'path';

export interface MigrationResult {
  migrated: boolean;
  addedFields: string[];
  removedFields: string[];
}

export interface DetectMigrationResult {
  needed: boolean;
  fromVersion: string;
  toVersion: string;
  addedFields: string[];
  removedFields: string[];
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
 * Remove fields from agents that were incorrectly injected by a prior buggy
 * migration (where the template agent's credentials leaked into user agents).
 *
 * - telegram/discord: removed when botToken is an unresolved ${VAR} placeholder
 * - env: removed when the path references a different agent's directory
 *
 * Returns the list of paths removed.
 */
export function repairInjectedAgentFields(
  agents: Array<Record<string, unknown>>,
): string[] {
  const removed: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    // Remove channel blocks whose botToken is a ${VAR} placeholder
    for (const channel of ['telegram', 'discord'] as const) {
      const block = agent[channel];
      if (
        block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        PLACEHOLDER_RE.test(String((block as Record<string, unknown>).botToken ?? ''))
      ) {
        delete agent[channel];
        removed.push(`agents[${i}].${channel}`);
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
    removed.push(...repairInjectedAgentFields(configClone.agents as Array<Record<string, unknown>>));
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
    removed.push(...repairInjectedAgentFields(config.agents as Array<Record<string, unknown>>));
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

  return { migrated: true, addedFields: added, removedFields: removed };
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
    return { migrated: false, addedFields: [], removedFields: [] };
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
