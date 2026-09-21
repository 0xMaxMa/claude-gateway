import { CodexReadinessError, resolveCodexCredentials } from '../session/codex-auth';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { delimiter, isAbsolute } from 'path';
import { resolveCodexRuntime } from '../session/codex-runtime';

export interface DependencyCheck { name: string; ok: boolean; detail: string; required: boolean }
export type DependencyRunner = (file: string, args: string[], timeout: number) => Promise<string>;
export interface DependencyOptions {
  run?: DependencyRunner;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  uid?: number;
  /** Read only the worker executable selections; never load/migrate server config. */
  configPath?: string;
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
  checks.push(...await checkCodexDependencies(options));
  return checks;
}

async function checkCodexDependencies(options: DependencyOptions): Promise<DependencyCheck[]> {
  const checks: DependencyCheck[] = [];
  const selections = new Map<string, { bin: unknown; cwd: string; scopes: string[]; auth: { baseUrl?: string; apiKeyEnv?: string } }>();
  const add = (bin: unknown, scope: string, cwd = process.cwd(), auth: { baseUrl?: string; apiKeyEnv?: string } = {}) => {
    const relative = typeof bin === 'string' && (bin.includes('${') || !bin.startsWith('/') && !bin.startsWith('~') && /[/\\]/.test(bin)) ||
      (!bin || typeof bin === 'string' && !/[/\\]/.test(bin)) && (process.env.PATH ?? '').split(delimiter).some((part: string) => part && !isAbsolute(part));
    const key = JSON.stringify([bin, relative ? cwd : '', auth.baseUrl, auth.apiKeyEnv]);
    const old = selections.get(key);
    selections.set(key, { bin, cwd, auth, scopes: [...(old?.scopes ?? []), scope] });
  };
  if (options.configPath) {
    try {
      const config = JSON.parse(readFileSync(options.configPath, 'utf8'));
      const gatewayBin = config.gateway?.workers?.codex?.bin;
      add(gatewayBin, 'gateway', process.cwd(), config.gateway?.workers?.codex);
      if (Array.isArray(config.agents)) config.agents.forEach((agent: any, index: number) => {
        add(agent?.workers?.codex?.bin ?? gatewayBin, `agents[${index}]`, typeof agent?.workspace === 'string' ? agent.workspace : process.cwd(), { ...config.gateway?.workers?.codex, ...agent?.workers?.codex });
      });
    } catch {
      checks.push({ name: 'codexConfig', ok: false, required: false,
        detail: 'Cannot read worker executable selections from local config; checking default Codex only.' });
      add(undefined, 'default');
    }
  } else add(undefined, 'default');
  for (const { bin: selection, cwd, scopes, auth } of selections.values()) {
    const scope = scopes.length > 3 ? `${scopes.includes('gateway') ? 'gateway and ' : ''}${scopes.filter(s => s !== 'gateway').length} agents (shared configuration)` : scopes.join(', ');
    const context = `${scope}; optional for Codex workers/safemode. This checks the doctor process environment; gateway service PATH may differ.`;
    const name = selections.size === 1 ? 'codex' : `codex:${scopes[0]}`;
    let runtime: ReturnType<typeof resolveCodexRuntime>;
    try {
      if (selection !== undefined && typeof selection !== 'string') throw new Error('invalid selection');
      const expand = (value: string) => value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        if (process.env[key] === undefined) throw new Error('unresolved environment');
        return process.env[key]!;
      }).replace(/^~(?=\/|$)/, homedir());
      runtime = resolveCodexRuntime(selection === undefined ? undefined : expand(selection as string), expand(cwd));
    } catch {
      checks.push({ name, ok: false, required: false, detail: `Codex executable is missing, invalid, or cannot be resolved. Install Codex separately or correct workers.codex.bin/PATH. ${context}` });
      continue;
    }
    try {
      const output = await (options.run ?? runCommand)(runtime.executable, ['--version'], 5000);
      // Version output is executable-controlled: do not print arbitrary output or config values.
      const version = output.match(/\b(?:codex-cli|codex)\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/i)?.[1];
      const executable = JSON.stringify(runtime.executable.length > 240 ? `${runtime.executable.slice(0, 237)}...` : runtime.executable);
      checks.push({ name, ok: !!version, required: false,
        detail: `${version ? `Codex ${version}` : 'Codex ran but returned no recognizable version'}; executable ${executable}. ${context}` });
    } catch {
      checks.push({ name, ok: false, required: false, detail: `Codex executable could not run --version. ${context}` });
    }
    if (!options.run) {
      try {
        const credentials = await resolveCodexCredentials({ ...auth, bin: runtime.executable });
        checks.push({ name: `${name}Auth`, ok: true, required: false, detail: `${credentials.chatgpt ? 'Native ChatGPT login' : 'Native API-key provider'} available for workers. Network access, model entitlement and quota have not been verified.` });
      } catch (error) {
        const reason = error instanceof CodexReadinessError ? `${error.code}: ${error.message}` : 'Native Codex readiness could not be checked. Run codex login status under the gateway service user.';
        checks.push({ name: `${name}Auth`, ok: false, required: false, detail: `${reason} Auto routing can use Claude Code; explicit Codex requires this check to pass.` });
      }
    }
    checks.push({ name: `${name}Container`, ok: !runtime.containerError, required: false,
      detail: runtime.containerError
        ? `Codex installation is not compatible with the container runtime layout. Install a supported native binary or npm distribution. ${context}`
        : `Runtime files available for container mounting. Docker engine/image readiness is not checked.` });
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
