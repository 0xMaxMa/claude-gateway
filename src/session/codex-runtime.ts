import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { homedir } from 'os';

export interface CodexRuntimeMount { source: string; target: string; readOnly: true }
export interface CodexRuntime {
  /** Keep the npm launcher for host execution, including its environment setup. */
  executable: string;
  nativeExecutable?: string;
  nativeSha256?: string;
  mounts: CodexRuntimeMount[];
  containerExecutable: string;
  fingerprint: string;
  containerError?: string;
}
export const CODEX_CONTAINER_ROOT = '/opt/gateway-codex';
export const CODEX_CONTAINER_EXECUTABLE = `${CODEX_CONTAINER_ROOT}/bin/codex`;
const containerRoot = CODEX_CONTAINER_ROOT;
const hashCache = new Map<string, string>();
function binaryHash(filename: string): string {
  const stat = fs.statSync(filename);
  const key = JSON.stringify([filename, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hash = createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  const value = hash.digest('hex');
  if (hashCache.size >= 16) hashCache.delete(hashCache.keys().next().value!);
  hashCache.set(key, value);
  return value;
}
function executableFile(filename: string): string | undefined {
  try {
    const real = fs.realpathSync(filename);
    if (!fs.statSync(real).isFile()) return;
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch { return; }
}
function header(filename: string): Buffer {
  const fd = fs.openSync(filename, 'r');
  try { const bytes = Buffer.alloc(64); const count = fs.readSync(fd, bytes, 0, bytes.length, 0); return bytes.subarray(0, count); }
  finally { fs.closeSync(fd); }
}
function linuxExecutable(filename: string): boolean {
  const bytes = header(filename);
  return bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (process.arch === 'arm64' ? 183 : 62);
}

/** Optional host runtime discovery. Never installs or executes software or reads Codex state. */
export function resolveCodexRuntime(bin?: string, cwd: string = process.cwd()): CodexRuntime {
  const command = bin ?? 'codex';
  let executable = command.includes('/') || command.includes('\\')
    ? executableFile(path.resolve(cwd, command))
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .map(dir => executableFile(path.resolve(cwd, dir, command))).find(Boolean);
  // Services often omit the standalone install directory from PATH. Only the
  // default selection may fall back; an explicit bin must keep its meaning.
  if (!executable && bin === undefined) {
    const home = homedir();
    if (path.isAbsolute(home)) executable = executableFile(path.join(home, '.local', 'bin', 'codex'));
  }
  if (!executable) throw new Error(`Codex executable ${JSON.stringify(command)} is missing or not executable. Install Codex on the gateway host or set workers.codex.bin to an executable path visible to the gateway service.`);
  const runtime: CodexRuntime = { executable, mounts: [], containerExecutable: `${containerRoot}/bin/codex`, fingerprint: '' };
  const digest = createHash('sha256');
  const record = (filename: string): void => {
    const stat = fs.statSync(filename);
    digest.update(JSON.stringify([filename, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  };
  try {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('app workers require a Linux x64 or arm64 host and a Docker daemon on that same host');
    let native = executable;
    if (!linuxExecutable(native)) {
      if (header(native).subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error(`the native binary is not a Linux ${process.arch} ELF executable`);
      const packageRoot = path.dirname(path.dirname(executable));
      const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      if (metadata.name !== '@openai/codex' || path.basename(executable) !== 'codex.js') throw new Error('the configured launcher is not a recognized Codex npm installation');
      const triple = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
      let vendor = path.join(packageRoot, 'vendor');
      try {
        const packageJson = createRequire(executable).resolve(`@openai/codex-linux-${process.arch}/package.json`);
        vendor = path.join(path.dirname(packageJson), 'vendor');
      } catch { /* Older npm releases bundle vendor directly in the launcher package. */ }
      const root = path.join(vendor, triple);
      native = executableFile(path.join(root, 'bin', 'codex')) ?? executableFile(path.join(root, 'codex', 'codex')) ?? '';
      if (!native) throw new Error('the Codex npm native platform package is missing; reinstall Codex with its optional dependencies');
    }
    if (!linuxExecutable(native)) throw new Error(`the native binary is not a Linux ${process.arch} ELF executable`);
    runtime.nativeExecutable = native;
    runtime.nativeSha256 = binaryHash(native);
    digest.update(runtime.nativeSha256);
    const nativeDir = path.dirname(native);
    // Mount only the executable, known companion executables and Codex resource trees.
    // In particular, never bind the install parent, which may be a user's home/bin.
    const root = path.dirname(nativeDir);
    const add = (source: string, target: string): void => {
      const real = fs.realpathSync(source);
      const walk = (filename: string): void => {
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error('runtime resources contain symlinks; install a self-contained Codex runtime');
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('runtime resources contain unsupported special files');
        record(filename);
        if (stat.isDirectory()) for (const child of fs.readdirSync(filename).sort()) walk(path.join(filename, child));
      };
      if (real !== source) throw new Error('runtime resources link outside their installation; install a self-contained Codex runtime');
      walk(real);
      runtime.mounts.push({ source: real, target, readOnly: true });
    };
    add(native, runtime.containerExecutable);
    const companion = path.join(nativeDir, 'codex-code-mode-host');
    if (fs.existsSync(companion)) add(companion, `${containerRoot}/bin/codex-code-mode-host`);
    // Only recognize sibling resources for the published bin/codex or legacy codex/codex layout.
    if (['bin', 'codex'].includes(path.basename(nativeDir))) {
      for (const name of ['codex-path', 'codex-resources', 'path']) {
        const directory = path.join(root, name);
        if (fs.existsSync(directory)) add(directory, `${containerRoot}/${name}`);
      }
    }
  } catch (error) {
    runtime.mounts = [];
    runtime.containerError = `Codex is available for host workers but cannot be mounted for app workers: ${error instanceof Error ? error.message : String(error)}. Install a compatible standalone or npm Codex runtime on the Docker host and reconcile the agent service.`;
  }
  runtime.fingerprint = digest.update(runtime.containerError ?? '').digest('hex');
  return runtime;
}
