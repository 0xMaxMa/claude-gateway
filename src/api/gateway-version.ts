import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the gateway's own version from package.json once per process. Resolved
 * relative to the compiled location (dist/api/ → package root), so it works for
 * a global npm install and a local checkout alike. Falls back to 'unknown' rather
 * than throwing — a missing/garbled package.json must never take the server down.
 */
export function getGatewayVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const GATEWAY_VERSION = getGatewayVersion();
