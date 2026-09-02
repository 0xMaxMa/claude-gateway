import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { CliConfigView, resolveLocalUrl } from '../http-client';
import { probeHealth } from '../health';
import { detectManager, defaultPidfilePath, pidLooksLikeGateway } from '../manager';
import { printJson } from '../output';
import { writeCommandHelp } from '../output';
import { runGatewayLogs } from './logs';

/**
 * `gateway start|status|restart|stop|logs` — whole-process lifecycle.
 *
 * `start` is handled by the boot entry point (src/index.ts), which recognises
 * it before the CLI is ever imported; it is listed here only so the usage text
 * and an unknown-verb error stay honest. Restart/stop must be performed by
 * whatever manager owns the process (it has to stop the very process serving
 * HTTP), so detection resolves the manager and the action is delegated to it.
 *
 * `logs` is the odd one out: it touches no process at all, reading the log
 * files directly so it still answers when the gateway is wedged or dead. It
 * lives here because the logs are the gateway's, and an operator looking for
 * them looks under the noun they already know.
 */
export async function runGatewayLifecycle(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb) {
    // `gateway --help` is a help request (0); a bare `gateway` is a usage error (1).
    writeCommandHelp(
      flags.help === true,
      'gateway',
      'manage the gateway process on this host',
      'claude-gateway gateway <start|status|restart|stop|logs>',
      [
        '  start is the only command that boots a server; status/restart/stop are manager-aware.',
        '  logs reads the log files directly and works even when the gateway is dead.',
      ],
    );
    return flags.help === true ? 0 : 1;
  }

  switch (verb) {
    case 'start':
      // Only reachable when runCli() is called directly (tests, embedding) —
      // the installed binary routes `gateway start` straight into the server.
      process.stderr.write('`gateway start` is handled by the claude-gateway entry point, not the CLI runner.\n');
      return 1;
    case 'status':
      return gatewayStatus(flags, config);
    case 'restart':
      return gatewayAction('restart');
    case 'stop':
      return gatewayAction('stop');
    case 'logs':
      return runGatewayLogs(flags);
    default:
      process.stderr.write(`Unknown: gateway ${verb} (expected start|status|restart|stop|logs)\n`);
      return 1;
  }
}

async function gatewayStatus(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const manager = detectManager();
  // `manager` describes the process on this host, so `health` must too:
  // probing config.publicUrl would report a reverse proxy (possibly fronting a
  // different instance) rather than the gateway this command just detected.
  const baseUrl = resolveLocalUrl({ flagUrl: typeof flags.url === 'string' ? flags.url : undefined, env: process.env, config });
  // `detail` carries what `health` cannot: an address answering 401 or 500 is
  // not the same failure as one answering nothing, and collapsing both into
  // "down" throws away the only clue about which one it is.
  const probe = await probeHealth(baseUrl);
  printJson({ manager, url: baseUrl, health: probe.ok ? 'up' : 'down', detail: probe.detail }, flags);
  return probe.ok ? 0 : 1;
}

function gatewayAction(action: 'restart' | 'stop'): Promise<number> {
  const manager = detectManager();
  try {
    switch (manager) {
      case 'systemd-user':
        execFileSync('systemctl', ['--user', action, 'claude-gateway.service'], { stdio: 'inherit' });
        return Promise.resolve(0);
      case 'systemd-system': {
        // A system-scoped unit needs root; announce the escalation instead of
        // silently invoking sudo, and skip it entirely when already root.
        const needsSudo = typeof process.getuid === 'function' && process.getuid() !== 0;
        if (needsSudo) {
          process.stderr.write(`Using the system service (may require sudo): systemctl ${action} claude-gateway.service\n`);
          execFileSync('sudo', ['systemctl', action, 'claude-gateway.service'], { stdio: 'inherit' });
        } else {
          execFileSync('systemctl', [action, 'claude-gateway.service'], { stdio: 'inherit' });
        }
        return Promise.resolve(0);
      }
      case 'pm2':
        execFileSync('pm2', [action, 'gateway'], { stdio: 'inherit' });
        return Promise.resolve(0);
      case 'foreground': {
        const pid = parseInt(fs.readFileSync(defaultPidfilePath(), 'utf8').trim(), 10);
        // The pidfile only proves some process holds this pid. A gateway lost
        // to SIGKILL or the OOM killer leaves the file behind, and once the pid
        // is recycled this branch would SIGTERM an unrelated process and report
        // success. Confirm it is a gateway before signalling it.
        if (!pidLooksLikeGateway(pid)) {
          process.stderr.write(
            `Pidfile names pid ${pid}, but that process does not look like a gateway — refusing to signal it. ` +
              `The gateway likely died without cleaning up; remove ${defaultPidfilePath()} if it is stale.\n`,
          );
          return Promise.resolve(1);
        }
        process.kill(pid, 'SIGTERM');
        if (action === 'restart') {
          process.stderr.write(
            'Stopped the foreground gateway (SIGTERM) but a bare foreground process has no supervisor to respawn it — ' +
              'start it again with `claude-gateway gateway start`, or install a service with `claude-gateway service install`.\n',
          );
          // Only the "stop" half of restart happened — a caller/script checking
          // the exit code should see this as incomplete, not a successful restart.
          return Promise.resolve(1);
        }
        process.stderr.write(`Sent SIGTERM to gateway (pid ${pid}).\n`);
        return Promise.resolve(0);
      }
      default:
        process.stderr.write('Could not detect how the gateway is running (systemd-user/systemd-system/pm2/foreground). Nothing done.\n');
        return Promise.resolve(1);
    }
  } catch (err) {
    process.stderr.write(`gateway ${action} failed: ${(err as Error).message}\n`);
    return Promise.resolve(1);
  }
}
