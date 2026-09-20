import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome } from '../utils/paths';
import { readRuntimeProvenance } from './provenance';
import { SafemodeCli, SafemodeSession } from './store';

export function resolveSafemodeSettings(flags: Record<string, string | boolean>, session?: SafemodeSession): {cli: SafemodeCli; model: string} {
  const file = resolveSafemodeConfigPath(flags, session);
  let config: {cli?: unknown; claude?: {model?: unknown}; codex?: {model?: unknown}} = {};
  try { config = JSON.parse(fs.readFileSync(expandHome(file), 'utf8')).safemode ?? {}; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read safemode config'); }
  const cli = flags.cli ?? session?.cli ?? config.cli ?? 'claude';
  if (cli !== 'claude' && cli !== 'codex') throw new Error('Safemode CLI must be claude or codex');
  if (session && cli !== session.cli) throw new Error('Cannot resume a native conversation with a different CLI');
  const model = flags.model ?? session?.model ?? config[cli]?.model ?? 'inherit';
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('Invalid safemode model');
  return {cli, model};
}

export function resolveSafemodeConfigPath(flags: Record<string, string | boolean>, session?: SafemodeSession): string {
  const file = typeof flags.config === 'string' ? flags.config : session?.configPath || process.env.GATEWAY_CONFIG || readRuntimeProvenance()?.configPath || path.join(os.homedir(), '.claude-gateway', 'config.json');
  return path.resolve(expandHome(file));
}
