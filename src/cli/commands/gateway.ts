import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { CliConfigView, resolveUrl } from '../http-client';
import { detectManager, defaultPidfilePath } from '../manager';

/**
 * `gateway start|status|restart|stop` — whole-process lifecycle.
 *
 * `start` is handled by the boot entry point (src/index.ts), which recognises
 * it before the CLI is ever imported; it is listed here only so the usage text
 * and an unknown-verb error stay honest. Restart/stop must be performed by
 * whatever manager owns the process (it has to stop the very process serving
 * HTTP), so detection resolves the manager and the action is delegated to it.
 */
export async function runGatewayLifecycle(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb) {
    process.stderr.write('Usage: claude-gateway gateway <start|status|restart|stop>\n');
    // `gateway --help` is a help request (0); a bare `gateway` is a usage error (1).
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
    default:
      process.stderr.write(`Unknown: gateway ${verb} (expected start|status|restart|stop)\n`);
      return 1;
  }
}

async function gatewayStatus(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const manager = detectManager();
  const baseUrl = resolveUrl({ flagUrl: typeof flags.url === 'string' ? flags.url : undefined, env: process.env, config });
  let health: 'up' | 'down' = 'down';
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(t);
    if (res.ok) health = 'up';
  } catch {
    health = 'down';
  }
  process.stdout.write(JSON.stringify({ manager, url: baseUrl, health }, null, 2) + '\n');
  return health === 'up' ? 0 : 1;
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
