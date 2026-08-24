import { execSync } from 'child_process';
import * as fs from 'fs';
import { CliConfigView, resolveUrl, resolveKey } from '../http-client';
import { detectManager, defaultPidfilePath } from '../manager';

/**
 * `gateway status|restart|stop` — whole-process lifecycle. Unlike session ops
 * (which have an HTTP endpoint), restarting/stopping the gateway is the job of
 * whatever manager owns it (systemd/pm2/foreground), because it must stop the
 * very process that serves HTTP. Detection resolves the manager; the action is
 * delegated to it.
 */
export async function runGatewayLifecycle(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb || (flags.help === true && !verb)) {
    process.stderr.write('Usage: claude-gateway gateway <status|restart|stop>\n');
    return verb ? 0 : 1;
  }

  switch (verb) {
    case 'status':
      return gatewayStatus(flags, config);
    case 'restart':
      return gatewayAction('restart');
    case 'stop':
      return gatewayAction('stop');
    default:
      process.stderr.write(`Unknown: gateway ${verb} (expected status|restart|stop)\n`);
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
  const out = { manager, url: baseUrl, health };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return health === 'up' ? 0 : 1;
}

function gatewayAction(action: 'restart' | 'stop'): Promise<number> {
  const manager = detectManager();
  const run = (cmd: string): void => {
    execSync(cmd, { stdio: 'inherit' });
  };
  try {
    switch (manager) {
      case 'systemd':
        process.stderr.write(`Using systemd (may require sudo): systemctl ${action} claude-gateway\n`);
        run(`sudo systemctl ${action} claude-gateway`);
        break;
      case 'pm2':
        run(`pm2 ${action} gateway`);
        break;
      case 'foreground': {
        const pidfile = defaultPidfilePath();
        const pid = parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10);
        process.kill(pid, 'SIGTERM');
        if (action === 'restart') {
          process.stderr.write(
            'Stopped the foreground gateway (SIGTERM). A bare foreground process has no supervisor to respawn it — start it again with `make start` / `npm start`.\n',
          );
        } else {
          process.stderr.write(`Sent SIGTERM to gateway (pid ${pid}).\n`);
        }
        break;
      }
      default:
        process.stderr.write(
          'Could not detect how the gateway is running (systemd/pm2/foreground). Nothing done.\n',
        );
        return Promise.resolve(1);
    }
  } catch (err) {
    process.stderr.write(`gateway ${action} failed: ${(err as Error).message}\n`);
    return Promise.resolve(1);
  }
  return Promise.resolve(0);
}
