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
 *
 * The same one-way copy makes `process.env` a cache that outlives the file it
 * came from: once a token is in there, a rotated value on disk cannot displace
 * it. That is why this module tracks which variables it injected — see
 * `injected` below.
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
 * Variables this module injected, and the file each one came from.
 *
 * `process.env` is the only thing `loadConfig()` interpolates from, and it is
 * process-lifetime state — so without this ledger there is no way to tell a
 * value the *operator* exported (which must never be clobbered) from one we
 * ourselves copied out of a `.env` on an earlier reload (which is just a stale
 * cache of a file that may since have changed). Both look identical in
 * `process.env`.
 */
const injected = new Map<string, { file: string; value: string }>();

/**
 * Fold a single agent's `.env` file into `process.env`.
 *
 * A variable the process already had — exported by the operator, or provided
 * by a *different* agent's `.env` — always wins; the file never clobbers it.
 * A variable this module injected from *this* file is refreshed when the file
 * changes, so a rotated token takes effect on reload instead of the process
 * serving the revoked one until it is restarted.
 *
 * The `value === current` check is what keeps those two cases apart after the
 * first load: if anything else has since assigned to the variable, the ledger
 * no longer matches, ownership is dropped, and the file goes back to losing.
 * Re-loading an unchanged file remains a no-op.
 */
function loadAgentEnvFile(envFile: string): void {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!key) continue;

    const current = process.env[key];
    if (current === undefined) {
      process.env[key] = val;
      injected.set(key, { file: envFile, value: val });
      continue;
    }

    const owned = injected.get(key);
    if (owned && owned.file === envFile && owned.value === current) {
      if (val !== current) {
        process.env[key] = val;
        injected.set(key, { file: envFile, value: val });
      }
    }
  }
}

/**
 * Fold every `agents/<id>/.env` under `gatewayAgentsDir` into `process.env`.
 *
 * Safe to run before each config load: it picks up agents that appeared since
 * the last one, and re-reading an unchanged file changes nothing.
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
