import * as yaml from 'js-yaml';
import * as nodeCron from 'node-cron';
import { HeartbeatTask } from '../types';
import { hasReversedCronRange } from '../cron/validate';

// ---------- Error classes ----------

export class InvalidCronError extends Error {
  constructor(taskName: string, expr: string) {
    super(`Task "${taskName}": invalid cron expression "${expr}"`);
    this.name = 'InvalidCronError';
  }
}

export class InvalidIntervalError extends Error {
  constructor(taskName: string, interval: string) {
    super(`Task "${taskName}": invalid interval "${interval}"`);
    this.name = 'InvalidIntervalError';
  }
}

export class MissingPromptError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" is missing required field "prompt"`);
    this.name = 'MissingPromptError';
  }
}

export class MissingNameError extends Error {
  constructor(index: number) {
    super(`Task at index ${index} is missing required field "name"`);
    this.name = 'MissingNameError';
  }
}

export class AmbiguousScheduleError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" specifies both "cron" and "interval" — use exactly one`);
    this.name = 'AmbiguousScheduleError';
  }
}

export class MissingScheduleError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" must specify either "cron" or "interval"`);
    this.name = 'MissingScheduleError';
  }
}

// ---------- Cron validation ----------

/**
 * Validate a 5-field cron expression with node-cron, the library that
 * schedules it, so the parser never accepts what `nodeCron.schedule()` rejects
 * or rejects what it supports (lists of ranges, MON-FRI, JAN, ...).
 * node-cron also accepts a leading seconds field; heartbeats stay at 5 fields.
 * Reversed ranges are rejected because node-cron would silently swap them.
 */
function validateCron(expr: string): boolean {
  return expr.split(/\s+/).length === 5 && nodeCron.validate(expr) && !hasReversedCronRange(expr);
}

// ---------- Interval conversion ----------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type IntervalSchedule = { cron: string } | { intervalMs: number };

/**
 * Convert an interval string (30m, 2h, 1d, 1w) to a schedule.
 *
 * An interval that divides its cycle (60 minutes, 24 hours) maps to a
 * wall-clock cron, so 30m fires at :00 and :30. Any other value has no even
 * cron equivalent (a 45-minute step fires at :00 and :45, 15 minutes apart),
 * so it becomes a fixed gap in milliseconds. Returns null for an invalid value.
 */
export function parseInterval(interval: string): IntervalSchedule | null {
  const match = interval.match(/^(\d+)([mhdw])$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);

  switch (match[2]) {
    case 'm':
      if (value < 1 || value > 59) return null;
      return 60 % value === 0 ? { cron: `*/${value} * * * *` } : { intervalMs: value * MINUTE_MS };
    case 'h':
      if (value < 1 || value > 23) return null;
      return 24 % value === 0 ? { cron: `0 */${value} * * *` } : { intervalMs: value * HOUR_MS };
    case 'd':
      return value === 1 ? { cron: '0 0 * * *' } : null;
    case 'w':
      return value === 1 ? { cron: '0 0 * * 0' } : null;
    default:
      return null;
  }
}

// ---------- YAML extraction ----------

/**
 * Extract the YAML block from a heartbeat.md content string.
 * The YAML block is everything before the first markdown heading (`#`) line
 * that appears after the YAML content starts.
 *
 * Strategy: find the `tasks:` key, collect lines until we hit a line that
 * starts with `#` (markdown heading) that is NOT inside a YAML string.
 */
function extractYamlBlock(content: string): string {
  const lines = content.split('\n');
  const yamlLines: string[] = [];
  let inYaml = false;

  for (const line of lines) {
    // Detect start of YAML (tasks: key at root level)
    if (!inYaml && /^tasks\s*:/.test(line)) {
      inYaml = true;
    }

    if (inYaml) {
      // Stop at a markdown heading that is at column 0 and not part of YAML value
      // A line starting with `#` that is NOT indented signals end of YAML block
      if (/^#/.test(line)) {
        break;
      }
      yamlLines.push(line);
    }
  }

  return yamlLines.join('\n');
}

// ---------- Main parser ----------

export function parseHeartbeat(content: string): HeartbeatTask[] {
  const yamlBlock = extractYamlBlock(content);

  if (!yamlBlock.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) {
    return [];
  }

  const rawTasks = root.tasks as unknown[];
  if (rawTasks.length === 0) {
    return [];
  }

  const tasks: HeartbeatTask[] = [];

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i] as Record<string, unknown>;

    // Validate name
    if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new MissingNameError(i);
    }
    const name = raw.name.trim();

    // Validate prompt
    if (!raw.prompt || typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
      throw new MissingPromptError(name);
    }
    const prompt = raw.prompt.trim();

    const hasCron = 'cron' in raw && raw.cron !== undefined && raw.cron !== null;
    const hasInterval = 'interval' in raw && raw.interval !== undefined && raw.interval !== null;

    if (hasCron && hasInterval) {
      throw new AmbiguousScheduleError(name);
    }
    if (!hasCron && !hasInterval) {
      throw new MissingScheduleError(name);
    }

    if (hasCron) {
      const cron = String(raw.cron).trim();
      if (!validateCron(cron)) {
        throw new InvalidCronError(name, cron);
      }
      tasks.push({ name, prompt, cron });
    } else {
      const intervalStr = String(raw.interval).trim();
      const schedule = parseInterval(intervalStr);
      if (!schedule) {
        throw new InvalidIntervalError(name, intervalStr);
      }
      tasks.push({ name, prompt, ...schedule });
    }
  }

  return tasks;
}
