jest.mock('../../src/cli/manager', () => ({
  detectManager: jest.fn(),
  defaultPidfilePath: () => '/tmp/fake-gateway.pid',
}));
jest.mock('fs', () => ({ readFileSync: jest.fn() }));
jest.mock('child_process', () => ({ execSync: jest.fn() }));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { detectManager } from '../../src/cli/manager';
import { runGatewayLifecycle } from '../../src/cli/commands/gateway';
import type { CliConfigView } from '../../src/cli/http-client';

/**
 * `gateway restart` on a bare foreground process only sends SIGTERM — there is
 * no supervisor to respawn it. A caller (script, cron job) reading the exit code
 * must be able to tell that apart from an actual completed restart.
 */
describe('cli gateway lifecycle exit codes', () => {
  const config: CliConfigView = {};
  let killSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('foreground restart sends SIGTERM but exits non-zero (no respawn happened)', async () => {
    (detectManager as jest.Mock).mockReturnValue('foreground');
    (fs.readFileSync as jest.Mock).mockReturnValue('4242\n');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(code).toBe(1);
  });

  it('foreground stop sends SIGTERM and exits zero (stop is the whole job)', async () => {
    (detectManager as jest.Mock).mockReturnValue('foreground');
    (fs.readFileSync as jest.Mock).mockReturnValue('4242\n');

    const code = await runGatewayLifecycle(['stop'], {}, config);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(code).toBe(0);
  });

  it('systemd restart delegates to systemctl and exits zero', async () => {
    (detectManager as jest.Mock).mockReturnValue('systemd');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execSync).toHaveBeenCalledWith('sudo systemctl restart claude-gateway', expect.anything());
    expect(code).toBe(0);
  });

  it('pm2 restart delegates to pm2 and exits zero', async () => {
    (detectManager as jest.Mock).mockReturnValue('pm2');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(execSync).toHaveBeenCalledWith('pm2 restart gateway', expect.anything());
    expect(code).toBe(0);
  });

  it('unknown manager does nothing and exits non-zero', async () => {
    (detectManager as jest.Mock).mockReturnValue('unknown');

    const code = await runGatewayLifecycle(['restart'], {}, config);

    expect(killSpy).not.toHaveBeenCalled();
    expect(code).toBe(1);
  });
});
