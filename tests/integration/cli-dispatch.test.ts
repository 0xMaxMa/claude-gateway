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
  // NO_COLOR keeps stderr assertions byte-exact regardless of the developer's
  // own FORCE_COLOR; the colour path has its own tests below.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra };
  delete env.INVOCATION_ID;
  delete env.PM2_HOME;
  delete env.pm_id;
  delete env.FORCE_COLOR;
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
    expect(stderr).toMatch(/claude-gateway v\d+\.\d+\.\d+ — control a running gateway/);
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
    expect(stderr).toMatch(/claude-gateway v\d+\.\d+\.\d+ — control a running gateway/);
  }, TIMEOUT_MS);
});

describe('binary dispatch — help colouring', () => {
  const base = () => terminalEnv({ GATEWAY_CONFIG: path.join(os.tmpdir(), 'cg-colour-should-never-be-read.json') });

  it('emits no ANSI escapes when stderr is piped', async () => {
    const env = base();
    delete env.NO_COLOR; // not a TTY, so colour must still stay off on its own
    const { stderr } = await run(['--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stderr).not.toMatch(/\x1b\[/);
  }, TIMEOUT_MS);

  /** terminalEnv() pins NO_COLOR and strips FORCE_COLOR; undo both to
   *  exercise the colour path. */
  const colourEnv = () => {
    const env = terminalEnv();
    delete env.NO_COLOR;
    env.FORCE_COLOR = '1';
    return env;
  };

  it('emits ANSI escapes when FORCE_COLOR is set', async () => {
    const { code, stderr } = await run(['--help'], colourEnv());
    expect(code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(stderr).toMatch(/\x1b\[1mclaude-gateway\x1b\[0m/);
  }, TIMEOUT_MS);

  it('NO_COLOR wins over FORCE_COLOR', async () => {
    const env = colourEnv();
    env.NO_COLOR = '1';
    const { stderr } = await run(['--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stderr).not.toMatch(/\x1b\[/);
  }, TIMEOUT_MS);

  it('colour never changes the plain-text column layout', async () => {
    // Node's ExperimentalWarning carries a PID, so drop it before comparing.
    const body = (s: string) => s.split('\n').filter((l) => !/^\((node:\d+|Use `node)/.test(l)).join('\n');
    const plain = await run(['--help'], terminalEnv());
    const painted = await run(['--help'], colourEnv());
    // eslint-disable-next-line no-control-regex
    expect(body(painted.stderr).replace(/\x1b\[[0-9;]*m/g, '')).toBe(body(plain.stderr));
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
