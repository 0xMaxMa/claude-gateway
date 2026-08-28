import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Dispatcher regression test — runs the *real* binary (dist/entry.js, the one
 * package.json points `bin` at), not
 * runCli(), because the bug this guards against lives in the entry point:
 * before this, `claude-gateway` with no command (or a typo, or `--help`) fell
 * through to main() and started a server on the gateway port. Anything that
 * only exercises runCli() cannot see that.
 *
 * Requires a build; `npm test` runs `npm run build` first (pretest).
 */

const ENTRY = path.resolve(__dirname, '../../dist/entry.js');
/** The pre-split entry. Service units written before `entry.js` existed still
 *  run this one, so it has to keep booting and keep dispatching. */
const LEGACY_ENTRY = path.resolve(__dirname, '../../dist/index.js');
const TIMEOUT_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Env with every supervisor marker stripped, so a test never accidentally
 *  takes the legacy-boot path (which would start a real server). */
function terminalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // NO_COLOR keeps the help assertions byte-exact regardless of the developer's
  // own FORCE_COLOR; the colour path has its own tests below.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra };
  delete env.INVOCATION_ID;
  delete env.PM2_HOME;
  delete env.pm_id;
  delete env.FORCE_COLOR;
  // Set in every process the gateway spawns. Inherited from the developer's own
  // shell it classifies the child as a supervised descendant, so these assertions
  // depended on where the suite happened to be run from.
  delete env.CLAUDE_GATEWAY_CHILD;
  return env;
}

function run(args: string[], env: NodeJS.ProcessEnv, entry: string = ENTRY): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const { code, stdout, stderr } = await run([], env());
    expect(code).toBe(0);
    // Help the user asked for is the result, so it is on stdout and pipeable.
    expect(stdout).toMatch(/claude-gateway v\d+\.\d+\.\d+ — control a running gateway/);
    expect(stdout).toMatch(/gateway start/);
    // Not `toBe('')`: Node writes its own warnings there. What matters is that
    // the help itself is not duplicated onto stderr.
    expect(stderr).not.toMatch(/control a running gateway/);
  }, TIMEOUT_MS);

  it('`--help` and `-h` print help and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, stdout } = await run([flag], env());
      expect(code).toBe(0);
      expect(stdout).toMatch(/Usage: claude-gateway <command>/);
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
    const { code, stdout } = await run(['--config', '/nonexistent-config.json'], env());
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude-gateway v\d+\.\d+\.\d+ — control a running gateway/);
  }, TIMEOUT_MS);
});

describe('binary dispatch — help layout', () => {
  /** Every core command must fit its name column and keep a readable gap; the
   *  longest (`service install|status|uninstall`) used to wrap its description
   *  onto the next line. */
  it('keeps each core command and its description on one line, with a visible gap', async () => {
    const { stdout } = await run(['--help'], terminalEnv());
    const rows = stdout
      .split('\n')
      .filter((l) => /^ {2}\S/.test(l) && / {2,}\S/.test(l.slice(2)))
      .filter((l) => !l.includes('Run `claude-gateway'));
    expect(rows.length).toBeGreaterThan(5);

    const longest = rows.find((l) => l.includes('service install|status|uninstall'));
    expect(longest).toBeDefined();
    expect(longest).toMatch(/service install\|status\|uninstall {2,}Run the gateway as a systemd-user or PM2 service/);

    // All descriptions start in the same column, so the block reads as a table.
    const descriptionColumn = (line: string) => {
      const gap = line.slice(2).search(/ {2,}\S/);
      return 2 + gap + line.slice(2 + gap).match(/^ +/)![0].length;
    };
    expect(new Set(rows.map(descriptionColumn)).size).toBe(1);
  }, TIMEOUT_MS);
});

describe('binary dispatch — help colouring', () => {
  const base = () => terminalEnv({ GATEWAY_CONFIG: path.join(os.tmpdir(), 'cg-colour-should-never-be-read.json') });

  it('emits no ANSI escapes when the help stream is piped', async () => {
    const env = base();
    delete env.NO_COLOR; // not a TTY, so colour must still stay off on its own
    const { stdout, stderr } = await run(['--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/);
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

  it('paints the program name in the brand tone when FORCE_COLOR is set', async () => {
    const env = colourEnv();
    env.TERM = 'xterm-256color'; // pinned: the palette degrades on a 16-colour TERM
    const { code, stdout } = await run(['--help'], env);
    expect(code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(stdout).toMatch(/\x1b\[1m\x1b\[38;5;208mclaude-gateway\x1b\[0m/);
  }, TIMEOUT_MS);

  it('reserves the brand tone for the general help banner', async () => {
    // Colour is a signal, not decoration: the orange name marks the one place
    // the program introduces itself, so subcommand help stays plain bold.
    const env = colourEnv();
    env.TERM = 'xterm-256color';
    const { stdout } = await run(['crons', '--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stdout).toMatch(/\x1b\[1mclaude-gateway\x1b\[0m/);
    expect(stdout).not.toContain('38;5;208');
  }, TIMEOUT_MS);

  it('degrades the brand tone on a 16-colour terminal', async () => {
    const env = colourEnv();
    env.TERM = 'xterm';
    delete env.COLORTERM;
    const { stdout } = await run(['--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stdout).toMatch(/\x1b\[1m\x1b\[33mclaude-gateway\x1b\[0m/);
  }, TIMEOUT_MS);

  it('NO_COLOR wins over FORCE_COLOR', async () => {
    const env = colourEnv();
    env.NO_COLOR = '1';
    const { stdout } = await run(['--help'], env);
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/);
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

describe('binary dispatch — inherited INVOCATION_ID from a non-systemd parent is not trusted', () => {
  /**
   * Regression for the bug this fixes: `INVOCATION_ID` is inherited by every
   * descendant of *any* systemd unit's main process, not just the one systemd
   * directly forked. A shell reached through an unrelated systemd-managed
   * process (a web-terminal service, say) carries the same env var while its
   * actual parent is that shell, not systemd. Before the `parentIsSystemd`
   * check landed, this was enough to spoof a legacy-boot and start a second
   * gateway on top of one already running.
   *
   * Spawned directly from this test process — a normal parent, definitely not
   * systemd — so `isDirectSystemdChild()` reads a real, non-1 ppid and returns
   * `false`. Must resolve to `cli` (help), never boot.
   *
   * Genuine `ppid === 1` legacy-boot (an actual pre-1.8 systemd unit) can't be
   * fabricated portably from an integration test; it's covered by the pure
   * `isDirectSystemdChild`/`isSupervised`/`classifyInvocation` unit tests in
   * tests/unit/cli-supervisor.test.ts and tests/unit/cli-args.test.ts.
   */
  it('an inherited INVOCATION_ID without a systemd parent prints help and exits, never boots', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-boot-'));
    try {
      // Built by hand rather than terminalEnv(), which unconditionally deletes
      // INVOCATION_ID — exactly the variable this test needs to keep. Still
      // clears CLAUDE_GATEWAY_CHILD: this suite may itself be running inside a
      // gateway-spawned shell (an agent's own session), which would otherwise
      // short-circuit isSupervised() to false for an unrelated reason and let
      // this test pass without ever exercising the fix.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: '1',
        // Same shape as a shell reached through an unrelated systemd unit:
        // the marker is present, but this process's real parent is the test
        // runner, not systemd.
        INVOCATION_ID: 'test-invocation',
        HOME: home,
        GATEWAY_CONFIG: path.join(home, 'config.json'),
        PORT: '0',
      };
      delete env.CLAUDE_GATEWAY_CHILD;
      delete env.PM2_HOME;
      delete env.pm_id;
      delete env.FORCE_COLOR;

      const { code, stdout, stderr } = await run([], env);
      expect(code).toBe(0);
      expect(stdout).toContain('claude-gateway');
      expect(stderr).not.toContain('DEPRECATED');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

/**
 * The entry-point split (src/entry.ts). The CLI used to be dispatched from
 * src/index.ts, whose module scope pulls in the entire server graph, so every
 * CLI invocation paid for it and inherited its failures.
 */
describe('entry point does not load the server on the CLI path', () => {
  // I-CD-375a — the observable proof. dist/index.js loads better-sqlite3's
  // node:sqlite dependency at module scope, and Node announces that on stderr
  // before the CLI has written a byte. A clean stderr means the server graph
  // was never required.
  it('I-CD-375a: `--help` through the real bin writes nothing to stderr', async () => {
    const viaBin = await run(['--help'], terminalEnv());
    expect(viaBin.code).toBe(0);
    expect(viaBin.stdout).toContain('claude-gateway');
    expect(viaBin.stderr).toBe('');

    // Same command through the pre-split entry still works, and still shows the
    // noise — which is what makes the assertion above meaningful rather than
    // vacuous. If Node ever stops warning, this line fails and says so.
    const viaLegacy = await run(['--help'], terminalEnv(), LEGACY_ENTRY);
    expect(viaLegacy.code).toBe(0);
    expect(viaLegacy.stdout).toContain('claude-gateway');
    expect(viaLegacy.stderr).toContain('ExperimentalWarning');
  }, TIMEOUT_MS);

  // I-CD-375b — an old service unit runs `dist/index.js gateway start`; the
  // split must not strand those installs. Dispatch there still has to work.
  it('I-CD-375b: the pre-split entry still dispatches CLI commands', async () => {
    const res = await run(['--version'], terminalEnv(), LEGACY_ENTRY);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, TIMEOUT_MS);
});
