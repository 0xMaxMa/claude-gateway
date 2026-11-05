import { GatewayConfig } from '../types';
import { expandHome } from '../utils/paths';
import { DEFAULT_FILES_ROOT } from './paths';

/** `gateway.files.root`, which loadConfig has already validated. */
export function resolveFilesRoot(config: GatewayConfig): string {
  return expandHome(config.gateway.files?.root ?? DEFAULT_FILES_ROOT);
}

/** loadConfig sets `enabled: false` when the default root would expose HOME or the config dir, or its real path holds ":". */
export function filesEnabled(config: GatewayConfig): boolean {
  return config.gateway.files?.enabled !== false;
}
