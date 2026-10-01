// Run the real container scripts locally: `docker exec ... <container> node -e <script> ...`
// becomes `node -e <script> ...` on this host.
jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  return { ...real, spawn: jest.fn((bin: string, args: string[], options: object) => bin === 'docker' ? real.spawn(process.execPath, args.slice(args.indexOf('node') + 1), options) : real.spawn(bin, args, options)) };
});
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { stopContainerProfile } from '../../../src/orchestration/container';

const posix = process.platform === 'win32' ? test.skip : test;
posix('stopping a container attempt removes its appended system prompt file (#559)', async () => {
  const directory = '/tmp/gateway-orch-' + randomUUID();
  mkdirSync(directory, { mode: 0o700 });
  try {
    // A process identity that is no longer alive, so nothing is signalled.
    writeFileSync(directory + '/process.json', JSON.stringify({ pid: 2 ** 22 - 1, start: 'gone' }));
    writeFileSync(directory + '/system-prompt.md', 'prompt', { mode: 0o600 });
    expect(await stopContainerProfile('app-test', directory)).toBe(true);
    expect(existsSync(directory + '/system-prompt.md')).toBe(false);
    expect(existsSync(directory + '/process.json')).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

posix('a prompt file that cannot be removed does not turn a successful stop into a failure', async () => {
  const directory = '/tmp/gateway-orch-' + randomUUID();
  mkdirSync(directory + '/system-prompt.md', { recursive: true, mode: 0o700 });
  writeFileSync(directory + '/system-prompt.md/entry', 'x'); // rmSync without recursive fails on a non-empty directory
  try {
    writeFileSync(directory + '/process.json', JSON.stringify({ pid: 2 ** 22 - 1, start: 'gone' }));
    expect(await stopContainerProfile('app-test', directory)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
