import { execFile } from 'child_process';

export interface DependencyCheck { name: string; ok: boolean; detail: string; required: boolean }
export type DependencyRunner = (file: string, args: string[], timeout: number) => Promise<string>;
export interface DependencyOptions {
  run?: DependencyRunner;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  uid?: number;
}
const runCommand: DependencyRunner = (file, args, timeout) => new Promise((resolve, reject) => {
  // Gracefully ask the direct child to stop. sudo/package-manager descendants
  // may still be finishing; never claim a process-tree termination guarantee.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const child = execFile(file, args, { timeout, killSignal: 'SIGTERM', maxBuffer: 256 * 1024, encoding: 'utf8',
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }, (error, stdout) => {
    completed = true;
    if (watchdog) clearTimeout(watchdog);
    if (error) reject(error); else resolve(stdout);
  });
  // execFile can wait indefinitely if a child ignores TERM or descendants hold
  // its pipes. Bound the doctor's wait without force-killing package writes.
  child.stdin?.end();
  if (completed) return;
  watchdog = setTimeout(() => {
    child.kill('SIGTERM');
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    child.unref();
    reject(Object.assign(new Error('Dependency command timed out'), { code: 'DEPENDENCY_COMMAND_TIMEOUT' }));
  }, timeout + 1000);
});
async function probe(name: string, run: DependencyRunner, required: boolean): Promise<DependencyCheck> {
  try {
    const output = await run(name, [name === 'ffmpeg' || name === 'ffprobe' ? '-version' : '--version'], 5000);
    return { name, ok: true, required, detail: output.trim().split('\n')[0].slice(0, 160) || 'Available' };
  } catch {
    return { name, ok: false, required, detail: `${name} is missing or cannot run in this environment's PATH.` };
  }
}
export async function checkDependencies(options: DependencyOptions = {}): Promise<DependencyCheck[]> {
  const version = options.nodeVersion ?? process.versions.node;
  const node = { name: 'node', ok: Number(version.split('.')[0]) >= 22, required: true,
    detail: `Node.js ${version}; requires Node.js 22 or newer.` };
  const checks: DependencyCheck[] = [node];
  for (const name of ['claude', 'bun', 'ffmpeg', 'ffprobe']) {
    checks.push(await probe(name, options.run ?? runCommand, name === 'claude' || name === 'bun'));
  }
  return checks;
}
export interface DependencyRepair { ok: boolean; detail: string; checks: DependencyCheck[] }
let activeRepair: Promise<DependencyRepair> | undefined;
/** Explicit doctor fix only. Never invoked by probes or voice requests. */
export function repairVoiceDependencies(options: DependencyOptions = {}): Promise<DependencyRepair> {
  if (activeRepair) return activeRepair;
  activeRepair = repair(options).finally(() => { activeRepair = undefined; });
  return activeRepair;
}
async function repair(options: DependencyOptions): Promise<DependencyRepair> {
  const run = options.run ?? runCommand;
  const checks = await Promise.all(['ffmpeg', 'ffprobe'].map(name => probe(name, run, false)));
  if (checks.every(check => check.ok)) return { ok: true, detail: 'ffmpeg and ffprobe are already available.', checks };
  const platform = options.platform ?? process.platform;
  let file: string, args: string[], updateArgs: string[] | undefined;
  if (platform === 'darwin') {
    file = 'brew'; args = ['install', 'ffmpeg'];
  } else if (platform === 'linux') {
    if (!(await probe('apt-get', run, false)).ok) return { ok: false,
      detail: 'Automatic repair requires apt-get on Linux. Install the ffmpeg package with your system package manager, then run claude-gateway doctor.', checks };
    const root = (options.uid ?? process.getuid?.()) === 0;
    file = root ? 'apt-get' : 'sudo';
    updateArgs = root ? ['update'] : ['-n', 'apt-get', 'update'];
    args = root ? ['install', '-y', 'ffmpeg'] : ['-n', 'apt-get', 'install', '-y', 'ffmpeg'];
  } else return { ok: false, detail: 'Install ffmpeg and ffprobe using your operating system package manager, add them to PATH, then run claude-gateway doctor.', checks };
  try {
    if (updateArgs) await run(file, updateArgs, 120000);
    await run(file, args, 120000);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (failure.code === 'DEPENDENCY_COMMAND_TIMEOUT' || failure.code === 'ETIMEDOUT' || failure.killed || failure.signal) {
      return { ok: false, checks, detail: platform === 'linux'
        ? 'Package installation was interrupted or timed out. Package-manager processes may still be running; wait for them to finish and do not remove lock files. If dpkg reports an interrupted configuration, ask an administrator to run sudo dpkg --configure -a, then sudo apt-get install -y ffmpeg. Run claude-gateway doctor again.'
        : 'Package installation was interrupted or timed out. Homebrew processes may still be running; wait for them to finish, then run brew install ffmpeg and claude-gateway doctor again.' };
    }
    return { ok: false, checks,
    detail: platform === 'darwin'
      ? 'Could not install ffmpeg. Install Homebrew if needed, then run: brew install ffmpeg. Run claude-gateway doctor again.'
      : 'Could not install ffmpeg without prompting. Ask an administrator to run: sudo apt-get update && sudo apt-get install -y ffmpeg. Run claude-gateway doctor again.' }; }
  const after = await Promise.all(['ffmpeg', 'ffprobe'].map(name => probe(name, run, false)));
  return { ok: after.every(check => check.ok), checks: after,
    detail: after.every(check => check.ok) ? 'ffmpeg and ffprobe are ready.' : 'Installation completed, but ffmpeg or ffprobe is still unavailable in PATH. Run claude-gateway doctor in the gateway service environment.' };
}
