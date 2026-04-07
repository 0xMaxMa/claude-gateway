import * as fs from 'fs';
import { GatewayConfig, AgentConfig } from './types';

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
  constructor(varName: string) {
    super(`Missing environment variable: ${varName}`);
    this.name = 'MissingEnvVarError';
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

function validateAgent(agent: Record<string, unknown>, index: number): void {
  if (!agent.id || typeof agent.id !== 'string') {
    throw new ConfigValidationError(`Agent at index ${index} is missing required field "id"`);
  }
  if (!agent.telegram || typeof agent.telegram !== 'object') {
    throw new ConfigValidationError(`Agent "${agent.id}" is missing "telegram" config`);
  }
  const telegram = agent.telegram as Record<string, unknown>;
  if (!telegram.botToken || typeof telegram.botToken !== 'string') {
    throw new ConfigValidationError(`Agent "${agent.id}" is missing "telegram.botToken"`);
  }
  if (telegram.dmPolicy !== 'allowlist' && telegram.dmPolicy !== 'open') {
    throw new ConfigValidationError(
      `Agent "${agent.id}" has invalid dmPolicy "${telegram.dmPolicy}". Must be "allowlist" or "open".`
    );
  }

  if (agent.session !== undefined && typeof agent.session === 'object') {
    const session = agent.session as Record<string, unknown>;
    if (session.idleTimeoutMinutes !== undefined && (typeof session.idleTimeoutMinutes !== 'number' || session.idleTimeoutMinutes <= 0)) {
      throw new ConfigValidationError(`agent '${agent.id}': session.idleTimeoutMinutes must be > 0`);
    }
    if (session.maxConcurrent !== undefined && (typeof session.maxConcurrent !== 'number' || session.maxConcurrent <= 0)) {
      throw new ConfigValidationError(`agent '${agent.id}': session.maxConcurrent must be > 0`);
    }
  }
}

/**
 * Load and validate config.json from the given path.
 * Interpolates ${VAR} env vars throughout the config.
 */
export function loadConfig(configPath: string): GatewayConfig {
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

  // Validate each agent before interpolation (so we get good error messages)
  for (let i = 0; i < (config.agents as unknown[]).length; i++) {
    const agent = (config.agents as unknown[])[i];
    if (typeof agent !== 'object' || agent === null) {
      throw new ConfigValidationError(`Agent at index ${i} must be an object`);
    }
    validateAgent(agent as Record<string, unknown>, i);
  }

  // Check for duplicate IDs before interpolation
  const ids = new Set<string>();
  for (const agent of config.agents as Array<Record<string, unknown>>) {
    const id = agent.id as string;
    if (ids.has(id)) {
      throw new DuplicateAgentIdError(id);
    }
    ids.add(id);
  }

  // Now interpolate env vars (may throw MissingEnvVarError)
  const interpolated = interpolateObject(parsed) as GatewayConfig;

  return interpolated;
}
