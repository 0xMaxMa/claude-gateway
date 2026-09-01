import * as fs from 'fs';
import { GatewayConfig } from '../types';
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
 * Load and validate config.json from the given path.
 * Interpolates ${VAR} env vars throughout the config.
 */
export function loadConfig(configPath: string, options?: LoadConfigOptions): GatewayConfig {
  const reportSkipped = (skipped: SkippedAgent): void => {
    options?.onSkippedAgent?.(skipped);
  };
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(`Cannot read config file at "${configPath}": ${(err as Error).message}`);
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
  const skippedAgents: string[] = [];
  for (let i = 0; i < (config.agents as unknown[]).length; i++) {
    const agent = (config.agents as unknown[])[i];
    if (typeof agent !== 'object' || agent === null) {
      console.warn(`[gateway] Skipping agent at index ${i}: must be an object`);
      skippedAgents.push(`index ${i}`);
      reportSkipped({ id: `index ${i}`, reason: 'Config entry must be an object' });
      continue;
    }
    const error = validateAgent(agent as Record<string, unknown>, i);
    if (error) {
      const agentId = (agent as Record<string, unknown>).id || `index ${i}`;
      console.warn(`[gateway] Skipping agent "${agentId}": ${error}`);
      skippedAgents.push(String(agentId));
      reportSkipped({ id: String(agentId), reason: error });
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
        console.warn(`[gateway] Skipping agent "${agent.id}": ${err.message}`);
        skippedAgents.push(String(agent.id));
        reportSkipped({
          id: String(agent.id),
          reason: err.message,
          missingVar: err.varName,
        });
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
