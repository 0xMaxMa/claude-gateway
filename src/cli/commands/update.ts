import {
  PACKAGES,
  PackageConfig,
  ReleaseChannel,
  TargetVersion,
  getNpmListVersion,
  getTargetVersion,
  installNpmVersion,
  resolveCurrent,
  runNativeUpdate,
  updateAvailable,
} from '../../packages/registry';
import { detectManager } from '../manager';
import { confirmAction } from '../prompt';
import { printJson } from '../output';
import { writeCommandHelp } from '../output';

/**
 * `update [check]` (the gateway itself) and `claude version|update [check]`
 * (the Claude Code binary the gateway drives).
 *
 * Both delegate to src/packages/registry.ts — the same detect/install strategy
 * the dashboard's Update button uses — so a package updated from the terminal
 * and one updated from the UI end up in exactly the same place. `check` never
 * writes anything; `update` always shows current → target and asks first.
 */

type PackageId = 'claude-gateway' | 'claude-code';

const RELEASE_NOTES: Record<PackageId, (version: string) => string> = {
  'claude-gateway': (v) => `https://github.com/0xMaxMa/claude-gateway/releases/tag/v${v}`,
  'claude-code': () => 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
};

interface Resolved {
  config: PackageConfig;
  current: string | null;
  latest: string;
  channel: ReleaseChannel;
  hasUpdate: boolean;
}

/** Read the installed and published versions. Returns null (after reporting)
 *  when the registry can't be reached, so `check` never claims "up to date"
 *  merely because the lookup failed. `--latest` skips the package's `stable`
 *  channel and targets the newest release. */
async function resolve(id: PackageId, flags: Record<string, string | boolean>): Promise<Resolved | null> {
  const config = PACKAGES[id];
  const current = resolveCurrent(config);
  let target: TargetVersion | null;
  try {
    target = await getTargetVersion(config, { latest: flags.latest === true });
  } catch {
    target = null;
  }
  if (target === null) {
    process.stderr.write(`Could not reach the npm registry to look up ${config.npm}.\n`);
    return null;
  }
  return {
    config,
    current,
    latest: target.version,
    channel: target.channel,
    hasUpdate: updateAvailable(current, target.version),
  };
}

async function check(id: PackageId, flags: Record<string, string | boolean>): Promise<number> {
  const resolved = await resolve(id, flags);
  if (!resolved) return 1;
  printJson(
    {
      package: resolved.config.npm,
      current: resolved.current,
      latest: resolved.latest,
      channel: resolved.channel,
      hasUpdate: resolved.hasUpdate,
    },
    flags,
  );
  return 0;
}

/** Tell the operator exactly how to get the new code running. An npm install
 *  replaces the files on disk; the process already in memory keeps serving the
 *  old build until its manager restarts it. */
function printRestartGuidance(): void {
  const manager = detectManager();
  if (manager === 'unknown') {
    process.stderr.write('Restart the gateway to run the new version.\n');
    return;
  }
  process.stderr.write(
    `The running gateway still serves the previous build — restart it with \`claude-gateway gateway restart\` (${manager}).\n`,
  );
}

async function update(id: PackageId, flags: Record<string, string | boolean>): Promise<number> {
  const resolved = await resolve(id, flags);
  if (!resolved) return 1;
  const { config, current, latest, channel } = resolved;

  if (!resolved.hasUpdate) {
    printJson({ package: config.npm, from: current, to: current, updated: false }, flags);
    process.stderr.write(
      current === null
        ? `${config.npm} is not installed here — install it before updating.\n`
        : `Already on ${current} (published ${channel}: ${latest}).\n`,
    );
    return 0;
  }

  process.stderr.write(
    `\n${config.npm}\n  current: ${current ?? 'not installed'}\n  target:  ${latest} (${channel})\n` +
      `  notes:   ${RELEASE_NOTES[id](latest)}\n\n`,
  );
  if (!(await confirmAction(flags, 'update', `Update ${config.npm} to ${latest}?`))) {
    process.stderr.write('Aborted — nothing was installed.\n');
    return 1;
  }

  // Native-installer packages (claude-code) must use their own updater: an
  // `npm install -g` would write a second copy that isn't the binary on PATH.
  const error =
    config.update === 'native' && config.bin ? runNativeUpdate(config) : installNpmVersion(config.npm, latest);
  if (error !== null) {
    process.stderr.write(`Update failed: ${error}\n`);
    return 1;
  }

  const to = config.detect === 'binary' ? resolveCurrent(config) : getNpmListVersion(config.npm);
  printJson({ package: config.npm, from: current, to, updated: to !== current }, flags);
  if (to === current) {
    // A native updater can legitimately be a no-op on its own channel.
    process.stderr.write(`${config.npm} reports ${to ?? 'an unknown version'} after updating — no change.\n`);
    return 0;
  }
  if (id === 'claude-gateway') printRestartGuidance();
  return 0;
}



/** `claude-gateway update [check]` — the gateway's own package. */
export async function runUpdate(
  id: PackageId,
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const verb = positionals[0];
  if (flags.help === true) {
    writeCommandHelp(
      true,
      'update',
      "check for or install a newer claude-gateway",
      'claude-gateway update [check] [--latest] [--yes]',
      [
        '  check is read-only; the bare form installs after confirming.',
        '  Follows the npm `stable` dist-tag (or `latest` if nothing is promoted yet);',
        '  --latest targets the newest release instead.',
      ],
    );
    return 0;
  }
  if (!verb) return update(id, flags);
  if (verb === 'check') return check(id, flags);
  process.stderr.write(`Unknown: update ${verb} (expected no argument, or "check")\n`);
  return 1;
}

/** `claude-gateway claude <version|update [check]>` — the Claude Code binary. */
export async function runClaude(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [verb, sub] = positionals;
  if (!verb || flags.help === true) {
    writeCommandHelp(
      flags.help === true,
      'claude',
      'inspect or update the Claude Code binary',
      'claude-gateway claude <version|update [check]> [--yes]',
    );
    return flags.help === true ? 0 : 1;
  }
  if (verb === 'version') {
    const current = resolveCurrent(PACKAGES['claude-code']);
    if (current === null) {
      process.stderr.write('Claude Code is not installed, or `claude --version` failed.\n');
      return 1;
    }
    process.stdout.write(current + '\n');
    return 0;
  }
  if (verb === 'update') {
    if (!sub) return update('claude-code', flags);
    if (sub === 'check') return check('claude-code', flags);
    process.stderr.write(`Unknown: claude update ${sub} (expected no argument, or "check")\n`);
    return 1;
  }
  process.stderr.write(`Unknown: claude ${verb} (expected version|update)\n`);
  return 1;
}
