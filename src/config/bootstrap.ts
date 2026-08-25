import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { loadCleanTemplate, stripIgnoredPaths } from './migrator';

export interface BootstrapResult {
  created: boolean;
  /** Present only when `created` is true — the generated admin key is not recoverable afterward. */
  adminKey?: string;
}

/**
 * Create config.json from the template with a fresh random admin API key when
 * no config file exists yet (genuine first run). Never touches an existing file.
 *
 * Reuses the same template-cleaning path as migration (`loadCleanTemplate` +
 * `stripIgnoredPaths`) so a fresh install starts on the current `configVersion`
 * with the same defaults migration would otherwise converge it to — the only
 * addition is a real `gateway.api.keys` admin entry, since `_migration.ignorePaths`
 * strips that block out (it normally holds unresolved `${VAR}` placeholders that
 * would leak into the file with no matching env var).
 */
export function ensureConfigExists(configPath: string, templatePath: string): BootstrapResult {
  if (fs.existsSync(configPath)) {
    return { created: false };
  }

  let config: Record<string, unknown>;
  try {
    const { template, ignorePaths } = loadCleanTemplate(templatePath);
    stripIgnoredPaths(template, ignorePaths);
    config = template;
  } catch {
    config = { gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' } };
  }

  config.agents = [];

  const adminKey = randomBytes(24).toString('hex');
  const gateway = (config.gateway ??= {}) as Record<string, unknown>;
  gateway.api = {
    keys: [
      { key: adminKey, description: 'Admin (auto-generated on first run)', agents: '*', admin: true },
    ],
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    // 'wx' fails with EEXIST instead of overwriting if another process won a
    // concurrent first-boot race; mode 0o600 keeps the embedded admin key
    // from being readable by other local users (matches installer.ts's
    // convention for secret-bearing files).
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { created: false };
    }
    throw err;
  }

  return { created: true, adminKey };
}
