import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-agent `.env` loading.
 *
 * Agent secrets (bot tokens above all) live in
 * `~/.claude-gateway/agents/<id>/.env` and are referenced from `config.json`
 * as `${VAR}` placeholders. `loadConfig()` resolves those placeholders from
 * `process.env` alone, so the `.env` files must be folded into `process.env`
 * *before* every config load — not just the one at startup.
 *
 * Issue #427: `agent_create` writes a new `agents/<id>/.env` and a `${VAR}`
 * placeholder into `config.json` while the gateway is already running. Without
 * a refresh on reload, that variable is never in `process.env`, the agent is
 * silently dropped from the reloaded snapshot, and `agent.added` never fires —
 * so the handler that *would* have loaded the `.env` is itself unreachable.
 */

/**
 * The gateway's agents directory for a given config path — the sibling
 * `agents/` of `config.json`, which is where per-agent workspaces and their
 * `.env` files live.
 */
export function agentsDirForConfig(configPath: string): string {
  return path.join(path.dirname(configPath), 'agents');
}

/**
 * Fold a single agent's `.env` file into `process.env`.
 *
 * Values already in `process.env` win, so a variable exported by the operator
 * (or read from an earlier `.env`) is never clobbered. That also makes this
 * safe to call repeatedly: re-loading an unchanged file is a no-op.
 */
function loadAgentEnvFile(envFile: string): void {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Fold every `agents/<id>/.env` under `gatewayAgentsDir` into `process.env`.
 *
 * Idempotent by construction (see `loadAgentEnvFile`), so callers may run it
 * before each config load to pick up agents that appeared since the last one.
 * A missing directory, an unreadable file, or a `.env` belonging to an agent
 * that is not in the config are all non-fatal: config loading has its own
 * per-agent error handling, and failing here would take the whole gateway down
 * over one bad file.
 */
export function loadAgentEnvFiles(gatewayAgentsDir: string): void {
  let entries: string[];
  try {
    if (!fs.existsSync(gatewayAgentsDir)) return;
    entries = fs.readdirSync(gatewayAgentsDir);
  } catch {
    return;
  }
  for (const agentId of entries) {
    const envFile = path.join(gatewayAgentsDir, agentId, '.env');
    try {
      if (!fs.existsSync(envFile)) continue;
      loadAgentEnvFile(envFile);
    } catch {
      // Unreadable .env (permissions, race with a concurrent write): skip it
      // and let loadConfig() report the resulting unresolvable ${VAR}.
      continue;
    }
  }
}
