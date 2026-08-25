import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Dispatcher regression test — runs the *real* binary (dist/index.js), not
 * runCli(), because the bug this guards against lives in the entry point:
 * before this, `claude-gateway` with no command (or a typo, or `--help`) fell
 * through to main() and started a server on the gateway port. Anything that
 * only exercises runCli() cannot see that.
 *
 * Requires a build; `npm test` runs `npm run build` first (pretest).
 */

const ENTRY = path.resolve(__dirname, '../../dist/index.js');
const TIMEOUT_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Env with every supervisor marker stripped, so a test never accidentally
 *  takes the legacy-boot path (which would start a real server). */
function terminalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.INVOCATION_ID;
  delete env.PM2_HOME;
  delete env.pm_id;
  return env;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`\`${args.join(' ')}\` did not exit — it likely started a server. stderr: ${stderr}`));
    }, TIMEOUT_MS - 5_000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(() => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`${ENTRY} is missing — run \`npm run build\` before this suite.`);
  }
});

describe('binary dispatch — discovery never starts a server', () => {
  // A config path that does not exist: if one of these invocations ever booted
  // the server again, it would also have to create/read this file, which makes
  // an accidental regression visible instead of silent.
  const env = () => terminalEnv({ GATEWAY_CONFIG: path.join(os.tmpdir(), 'cg-dispatch-should-never-be-read.json') });

  it('a bare `claude-gateway` prints help and exits 0', async () => {
    const { code, stderr } = await run([], env());
    expect(code).toBe(0);
    expect(stderr).toMatch(/claude-gateway — control a running gateway/);
    expect(stderr).toMatch(/gateway start/);
  }, TIMEOUT_MS);

  it('`--help` and `-h` print help and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, stderr } = await run([flag], env());
      expect(code).toBe(0);
      expect(stderr).toMatch(/Usage: claude-gateway <command>/);
    }
  }, TIMEOUT_MS);

  it('`--version` prints the package version and exits 0', async () => {
    const { code, stdout } = await run(['--version'], env());
    expect(code).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(stdout.trim()).toBe((require('../../package.json') as { version: string }).version);
  }, TIMEOUT_MS);

  it('a plausible typo (`start`, `update-now`) reports an unknown command instead of booting', async () => {
    for (const typo of ['start', 'update-now', 'serve']) {
      const { code, stderr } = await run([typo], env());
      expect(code).toBe(1);
      expect(stderr).toMatch(new RegExp(`Unknown command: ${typo}`));
    }
  }, TIMEOUT_MS);

  it('a flag-only invocation still reaches the CLI rather than main()', async () => {
    const { code, stderr } = await run(['--config', '/nonexistent-config.json'], env());
    expect(code).toBe(0);
    expect(stderr).toMatch(/claude-gateway — control a running gateway/);
  }, TIMEOUT_MS);
});

describe('binary dispatch — legacy supervised units still boot', () => {
  it('warns and enters the server path when a supervisor passes no command', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-boot-'));
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        HOME: home,
        // Marks the launch as systemd-supervised, which is exactly the pre-1.8
        // unit shape (`ExecStart=/usr/local/bin/claude-gateway`, no command).
        INVOCATION_ID: 'test-invocation',
        GATEWAY_CONFIG: path.join(home, 'config.json'),
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const sawWarning = await new Promise<boolean>((resolve) => {
        let stderr = '';
        const timer = setTimeout(() => resolve(false), 10_000);
        child.stderr.on('data', (d) => {
          stderr += d.toString();
          if (stderr.includes('DEPRECATED')) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(stderr.includes('DEPRECATED'));
        });
      });
      expect(sawWarning).toBe(true);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
