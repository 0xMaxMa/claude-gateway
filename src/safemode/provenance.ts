import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { defaultPidfilePath } from '../cli/manager';

export interface BuildProvenance {
  schemaVersion: 1;
  packageVersion: string;
  builtAt: string;
  commit: string | null;
  tag: string | null;
  dirty: boolean | null;
}
export interface RuntimeProvenance {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  executablePath: string;
  entrypoint: string | null;
  packageRoot: string;
  packageVersion: string | null;
  configPath: string | null;
  port: number | null;
  /** Linux kernel start ticks distinguish a still-running process from PID reuse. */
  processStartTicks: string | null;
  build: BuildProvenance | null;
  checkoutAtStartup: { commit: string | null; branch: string | null; dirty: boolean | null } | null;
  installKind: 'git-checkout' | 'package';
  sourceConfidence: 'exact-build' | 'modified-build' | 'unknown';
}
function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 1024 * 1024,
    }).trim();
  } catch { return null; }
}
function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validBuild(value: unknown): value is BuildProvenance {
  return isObject(value) && value.schemaVersion === 1 && typeof value.packageVersion === 'string'
    && typeof value.builtAt === 'string' && Number.isFinite(Date.parse(value.builtAt))
    && (value.commit === null || (typeof value.commit === 'string' && /^[a-f0-9]{40,64}$/.test(value.commit)))
    && (value.tag === null || typeof value.tag === 'string')
    && (value.dirty === null || typeof value.dirty === 'boolean');
}
export function processStartTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}
export function defaultRuntimeProvenancePath(): string {
  return path.join(path.dirname(defaultPidfilePath()), 'runtime-provenance.json');
}
/** Capture once at startup. A later git checkout must never rewrite this evidence. */
export function captureRuntimeProvenance(options: {
  packageRoot?: string; pid?: number; startedAt?: string; configPath?: string; port?: number;
} = {}): RuntimeProvenance {
  const packageRoot = path.resolve(options.packageRoot ?? path.join(__dirname, '..', '..'));
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const manifest = readJson(path.join(packageRoot, 'dist', 'build-provenance.json'));
  const build = validBuild(manifest) ? manifest : null;
  const top = git(packageRoot, ['rev-parse', '--show-toplevel']);
  let checkout = false;
  try { checkout = top !== null && fs.realpathSync(top) === fs.realpathSync(packageRoot); } catch { /* Missing checkout. */ }
  const status = checkout ? git(packageRoot, ['status', '--porcelain', '--untracked-files=normal']) : null;
  const pid = options.pid ?? process.pid;
  const packageVersion = isObject(pkg) && typeof pkg.version === 'string' ? pkg.version : null;
  return {
    schemaVersion: 1, pid, startedAt: options.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString(),
    executablePath: process.execPath, entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : null,
    packageRoot, packageVersion, configPath: options.configPath ? path.resolve(options.configPath) : null,
    port: options.port ?? null, processStartTicks: processStartTicks(pid), build,
    checkoutAtStartup: checkout ? {
      commit: git(packageRoot, ['rev-parse', 'HEAD']), branch: git(packageRoot, ['symbolic-ref', '--short', '-q', 'HEAD']),
      dirty: status === null ? null : status.length > 0,
    } : null,
    installKind: checkout ? 'git-checkout' : 'package',
    sourceConfidence: build?.commit && build.packageVersion === packageVersion
      ? (build.dirty === false ? 'exact-build' : build.dirty === true ? 'modified-build' : 'unknown') : 'unknown',
  };
}
/** Private local evidence survives shutdown for post-mortem diagnosis. */
export function writeRuntimeProvenance(record: RuntimeProvenance, filePath = defaultRuntimeProvenancePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed or creation failed. */ }
  }
}
export function readRuntimeProvenance(filePath = defaultRuntimeProvenancePath()): RuntimeProvenance | null {
  const record = readJson(filePath);
  if (!isObject(record) || record.schemaVersion !== 1 || !Number.isInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
    || typeof record.packageRoot !== 'string' || !path.isAbsolute(record.packageRoot)
    || typeof record.executablePath !== 'string' || (record.build !== null && !validBuild(record.build))
    || !['exact-build', 'modified-build', 'unknown'].includes(String(record.sourceConfidence))) return null;
  return record as unknown as RuntimeProvenance;
}
/** Callers must label dead records as last-run evidence, never the current runtime. */
export function isRecordedRuntimeAlive(record: RuntimeProvenance): boolean {
  try { process.kill(record.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const ticks = processStartTicks(record.pid);
  return record.processStartTicks !== null && ticks !== null && ticks === record.processStartTicks;
}
