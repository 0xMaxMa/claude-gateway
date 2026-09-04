import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayConfig, Logger } from '../types';
import { resolveGatewayPublicUrl } from './public-url';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class DuplicateAgentIdError extends Error {
  constructor(id: string) {
    super(`Duplicate agent id: "${id}"`);
    this.name = 'DuplicateAgentIdError';
  }
}

export class MissingEnvVarError extends Error {
  /**
   * The unresolved variable, exposed separately so callers can log it as a
   * field instead of scraping it back out of `message`.
   */
  readonly varName: string;

  constructor(varName: string) {
    super(`Missing environment variable: ${varName}`);
    this.name = 'MissingEnvVarError';
    this.varName = varName;
  }
}

/**
 * Interpolate ${VAR} placeholders in a string value using process.env.
 * Throws MissingEnvVarError if any referenced variable is not set.
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new MissingEnvVarError(varName);
    }
    return envValue;
  });
}

/**
 * Recursively walk an object and interpolate all string values.
 */
function interpolateObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateObject(val);
    }
    return result;
  }
  return obj;
}

/**
 * Validate an agent config. Returns an error message if invalid, or null if valid.
 */
function validateAgent(agent: Record<string, unknown>, index: number): string | null {
  if (!agent.id || typeof agent.id !== 'string') {
    return `Agent at index ${index} is missing required field "id"`;
  }
  const hasTelegram = agent.telegram && typeof agent.telegram === 'object';
  const hasDiscord = agent.discord && typeof agent.discord === 'object';
  // Agents without channels are allowed (API-only agents accessed via HTTP API key)
  if (hasTelegram) {
    const telegram = agent.telegram as Record<string, unknown>;
    if (!telegram.botToken || typeof telegram.botToken !== 'string') {
      return `Agent "${agent.id}" is missing "telegram.botToken"`;
    }
  }
  if (hasDiscord) {
    const discord = agent.discord as Record<string, unknown>;
    if (!discord.botToken || typeof discord.botToken !== 'string') {
      return `Agent "${agent.id}" is missing "discord.botToken"`;
    }
  }

  if (agent.session !== undefined && typeof agent.session === 'object') {
    const session = agent.session as Record<string, unknown>;
    if (session.idleTimeoutMinutes !== undefined && (typeof session.idleTimeoutMinutes !== 'number' || session.idleTimeoutMinutes <= 0)) {
      return `agent '${agent.id}': session.idleTimeoutMinutes must be > 0`;
    }
    if (session.maxConcurrent !== undefined && (typeof session.maxConcurrent !== 'number' || session.maxConcurrent <= 0)) {
      return `agent '${agent.id}': session.maxConcurrent must be > 0`;
    }
  }
  return null;
}

/** An agent that was dropped from the loaded config rather than started. */
export interface SkippedAgent {
  /** The agent's id, or `index N` when the entry was too malformed to have one. */
  id: string;
  /** Human-readable cause, e.g. `Missing environment variable: ACME_BOT_TOKEN`. */
  reason: string;
  /** Set only when the agent was dropped because a `${VAR}` did not resolve. */
  missingVar?: string;
}

export interface LoadConfigOptions {
  /**
   * Called once per dropped agent. Skipping is deliberately non-fatal (one bad
   * agent must not take the gateway down), which historically made it invisible:
   * the only signal was a `console.warn` that never reaches `logs/gateway.log`.
   * Callers that have a structured logger should pass this so a dropped agent
   * is diagnosable — see issue #427.
   */
  onSkippedAgent?: (skipped: SkippedAgent) => void;
}

/**
 * Emit one `SkippedAgent` through a caller's structured logger.
 *
 * Shared by the startup load and every reload so both write the same fields
 * under the same key — `grep "Agent skipped" logs/gateway.log` finds either.
 */
export function logSkippedAgents(
  logger: Logger,
  skipped: readonly SkippedAgent[],
  message: string,
): void {
  for (const s of skipped) {
    logger.warn(message, {
      id: s.id,
      reason: s.reason,
      ...(s.missingVar ? { missingVar: s.missingVar } : {}),
    });
  }
}

/**
 * Load and validate config.json from the given path.
 * Interpolates ${VAR} env vars throughout the config.
 */
export function loadConfig(configPath: string, options?: LoadConfigOptions): GatewayConfig {
  const skippedAgents: string[] = [];

  /**
   * The single place an agent is dropped. Both the console warning and the
   * structured-logger callback go through here on purpose: when they were two
   * parallel statements per call site, a new skip site could easily carry one
   * and not the other — reintroducing exactly the invisible drop of #427.
   */
  const skipAgent = (id: string, reason: string, missingVar?: string): void => {
    console.warn(`[gateway] Skipping agent "${id}": ${reason}`);
    skippedAgents.push(id);
    options?.onSkippedAgent?.({ id, reason, ...(missingVar ? { missingVar } : {}) });
  };

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(`Cannot read config file at "${configPath}": ${(err as Error).message}`);
  }

  // Self-heal a config.json left wider than 0600 by a writer that predates
  // #460's fix (or ran before this fix reached that call site) — every
  // reload is a chance to repair it, not just the first one after upgrading.
  // Best-effort: an unreadable/immutable mode bit must not block loading a
  // config that otherwise parses and validates fine.
  try {
    if ((fs.statSync(configPath).mode & 0o777) !== 0o600) {
      fs.chmodSync(configPath, 0o600);
    }
  } catch {
    /* stat/chmod failed — not fatal, config still loads */
  }

  // Same repair for the containing directory: bootstrap.ts's mkdirSync(dir,
  // {mode: 0o700}) only applies its mode when it *creates* the directory —
  // recursive mkdirSync on an already-existing one is a no-op mode-wise, so
  // an install that predates #460 (i.e. every existing install) never
  // benefits from that fix at all, staying 0755 forever otherwise.
  //
  // Scoped to the default `~/.claude-gateway` home only — a `--config` /
  // `GATEWAY_CONFIG` pointed at a directory the operator shares with
  // something else (a sidecar, another service under a different user) must
  // keep whatever permissions they set on it; only config.json itself
  // (chmod'd above, unconditionally) needs locking down in that case.
  try {
    const dir = path.dirname(configPath);
    const defaultGatewayHome = path.join(os.homedir(), '.claude-gateway');
    if (dir === defaultGatewayHome && (fs.statSync(dir).mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    /* stat/chmod failed — not fatal, config still loads */
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigValidationError('Config must be a JSON object');
  }

  const config = parsed as Record<string, unknown>;

  if (!Array.isArray(config.agents)) {
    throw new ConfigValidationError('Config is missing required "agents" array');
  }

  if (!config.gateway || typeof config.gateway !== 'object') {
    throw new ConfigValidationError('Config is missing required "gateway" object');
  }

  // Validate each agent before interpolation — skip invalid agents with a warning
  const validAgents: Record<string, unknown>[] = [];
  for (let i = 0; i < (config.agents as unknown[]).length; i++) {
    const agent = (config.agents as unknown[])[i];
    if (typeof agent !== 'object' || agent === null) {
      skipAgent(`index ${i}`, 'Config entry must be an object');
      continue;
    }
    const error = validateAgent(agent as Record<string, unknown>, i);
    if (error) {
      skipAgent(String((agent as Record<string, unknown>).id || `index ${i}`), error);
      continue;
    }
    validAgents.push(agent as Record<string, unknown>);
  }

  // Check for duplicate IDs among valid agents
  const ids = new Set<string>();
  for (const agent of validAgents) {
    const id = agent.id as string;
    if (ids.has(id)) {
      throw new DuplicateAgentIdError(id);
    }
    ids.add(id);
  }

  // Validate gateway.api.keys if present
  const gateway = config.gateway as Record<string, unknown>;
  if (gateway.api !== undefined) {
    const api = gateway.api as Record<string, unknown>;
    if (!Array.isArray(api.keys)) {
      throw new ConfigValidationError('gateway.api.keys must be an array');
    }
    const seenKeys = new Set<string>();
    for (const k of api.keys as unknown[]) {
      if (typeof k !== 'object' || k === null) {
        throw new ConfigValidationError('Each entry in gateway.api.keys must be an object');
      }
      const entry = k as Record<string, unknown>;
      if (!entry.key || typeof entry.key !== 'string') {
        throw new ConfigValidationError('Each API key must have a non-empty "key" string');
      }
      if (seenKeys.has(entry.key as string)) {
        throw new ConfigValidationError(`Duplicate API key value detected`);
      }
      seenKeys.add(entry.key as string);
      if (entry.agents !== '*' && !Array.isArray(entry.agents)) {
        throw new ConfigValidationError(
          `API key "${entry.key}": "agents" must be an array of agent IDs or the string "*"`,
        );
      }
    }
  }

  // Interpolate gateway config (fatal if env vars missing here)
  const interpolatedGateway = interpolateObject(config.gateway) as Record<string, unknown>;
  const rawPublicUrl = interpolatedGateway.publicUrl;
  if (typeof rawPublicUrl === 'string' && !rawPublicUrl.trim()) {
    // Blank/whitespace-only is "not configured", not "invalid". Normalize to
    // undefined so downstream consumers see a single unset representation and
    // report "not configured" rather than throwing or emitting a broken link.
    interpolatedGateway.publicUrl = undefined;
  } else if (rawPublicUrl !== undefined) {
    const normalizedPublicUrl = resolveGatewayPublicUrl(rawPublicUrl);
    if (!normalizedPublicUrl) {
      throw new ConfigValidationError(
        'gateway.publicUrl must be an HTTPS URL ending in /gateway with no credentials, query, or fragment ' +
        '(HTTP is allowed only for localhost and *.internal/*.local development hosts)',
      );
    }
    interpolatedGateway.publicUrl = normalizedPublicUrl;
  }

  // Interpolate each agent individually — skip agents with missing env vars
  const interpolatedAgents: unknown[] = [];
  for (const agent of validAgents) {
    try {
      interpolatedAgents.push(interpolateObject(agent));
    } catch (err) {
      if (err instanceof MissingEnvVarError) {
        skipAgent(String(agent.id), err.message, err.varName);
        continue;
      }
      throw err;
    }
  }

  // A genuinely empty "agents": [] is a valid bootstrap state (start the gateway,
  // then use `claude-gateway agents create` to add the first one). Only error when
  // agents WERE declared but every single one got filtered out — that's a real
  // misconfiguration (e.g. a missing ${VAR}), not an intentional empty install.
  if (interpolatedAgents.length === 0 && (config.agents as unknown[]).length > 0) {
    const bakPath = configPath + '.bak';
    const migrationHint = fs.existsSync(bakPath)
      ? ` A migration backup exists at "${bakPath}" — this may be a migration issue where credential fields were incorrectly injected into your agents. Check the backup and restore if needed.`
      : '';
    throw new ConfigValidationError(
      `No valid agents found in config. All agents were skipped due to configuration errors.${migrationHint}`
    );
  }

  if (skippedAgents.length > 0) {
    console.warn(`[gateway] ${skippedAgents.length} agent(s) skipped: ${skippedAgents.join(', ')}`);
  }

  return {
    agents: interpolatedAgents,
    gateway: interpolatedGateway,
  } as GatewayConfig;
}
