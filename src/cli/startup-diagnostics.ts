import { validateJevConfig } from '../jev/validation';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { expandHome } from './http-client';

export interface StartupCheck { name: string; ok: boolean; detail: string; warn?: boolean; info?: boolean }
export function doctorConfigPath(flags: Record<string, string | boolean>): string {
  return path.resolve(expandHome(typeof flags.config === 'string' ? flags.config : process.env.GATEWAY_CONFIG || path.join(os.homedir(), '.claude-gateway', 'config.json')));
}
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code || 'FAILED';
function resolvedLogDirectory(config: any): string {
  const configured = typeof config?.gateway?.logDir === 'string' ? config.gateway.logDir : path.join(os.homedir(), '.claude-gateway', 'logs');
  const resolved = configured.replace(/\$\{([^}]+)\}/g, (_match: string, name: string) => {
    if (process.env[name] === undefined) throw Object.assign(new Error(), { code: 'UNRESOLVED_LOG_DIR_ENV' });
    return process.env[name]!;
  });
  if (!resolved.trim()) throw Object.assign(new Error(), { code: 'EMPTY_LOG_DIR' });
  return path.resolve(expandHome(resolved));
}
/** Deliberately no loadConfig(): startup migration and permission repair mutate disk. */
export function inspectStartup(file: string): StartupCheck[] {
  const checks: StartupCheck[] = [];
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { return [{ name: 'configFile', ok: false, detail: `${file}: ${errorCode(error)}. Restore or create a valid config; check file ownership.` }]; }
  let config: any;
  try { config = JSON.parse(raw); }
  catch { return [{ name: 'configFile', ok: false, detail: raw.charCodeAt(0) === 0xfeff ? 'UTF-8 BOM prevents parsing. Run claude-gateway doctor fix.' : 'Invalid JSON. Correct the syntax or restore a known-good backup; no configuration content was printed.' }]; }
  const valid = config && !Array.isArray(config) && typeof config === 'object' && Array.isArray(config.agents) && config.agents.length > 0 && config.gateway && !Array.isArray(config.gateway) && typeof config.gateway === 'object';
  checks.push({ name: 'configStructure', ok: !!valid, detail: valid ? 'gateway object and nonempty agents array present (not a full runtime validation)' : 'Expected gateway object and nonempty agents array. Restore/correct config; doctor will not invent credentials or agents.' });
  try {
    const stat = fs.statSync(file);
    const privateMode = (stat.mode & 0o777) === 0o600;
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({ name: 'configAccess', ok: true, warn: !privateMode, detail: privateMode ? 'readable/writable; mode 0600' : 'mode is not 0600; doctor fix can restrict permissions on a file owned by this user' });
  } catch (error) { checks.push({ name: 'configAccess', ok: false, detail: `Config cannot be read/written (${errorCode(error)}). doctor fix can repair owner permission bits; foreign ownership requires administrator action.` }); }
  if(config?.gateway?.jev?.enabled){
    try {
      const jev=config.gateway.jev;validateJevConfig(jev);
      if(jev.apiKeyFile) {const st=fs.statSync(jev.apiKeyFile);if(!st.isFile()||st.size===0||st.size>16384)throw Error('Invalid credential file');fs.accessSync(jev.apiKeyFile,fs.constants.R_OK);}
      else if((jev.apiKeyEnv||jev.provider==='typesafe')&&!process.env[jev.apiKeyEnv||'TYPESAFE_API_KEY'])throw Error('Missing credential environment');
      checks.push({name:'jev',ok:true,detail:'Configuration and local credential reference checked; no paid inference performed. Upstream authentication is verified only by an explicit evaluation.'});
    }catch{checks.push({name:'jev',ok:false,detail:'Invalid Jev configuration or unreadable/missing credential reference. No inference was performed.'});}
  }
  let logDir: string;
  try { logDir = resolvedLogDirectory(config); } catch (error) { checks.push({ name: 'logDirectory', ok: false, detail: `${errorCode(error)}. Supply the same environment variables used by the gateway.` }); return checks; }
  for (const [name, dir] of [['runtimeDirectory', path.dirname(file)], ['logDirectory', logDir]]) {
    try { if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' }); fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); checks.push({ name, ok: true, detail: `writable: ${dir}` }); }
    catch (error) { checks.push({ name, ok: false, detail: `${dir}: ${errorCode(error)}. Check directory ownership/permissions; doctor fix creates a missing log directory.` }); }
  }
  // Only known signatures; never return log lines, prompts, tokens or provider payloads.
  const log = path.join(logDir, 'gateway.log');
  try {
    const fd = fs.openSync(log, 'r'); let tail: string;
    try { const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 65536)); const read = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); tail = bytes.subarray(0, read).toString(); }
    finally { fs.closeSync(fd); }
    const hints: [RegExp, string][] = [
      [/EADDRINUSE/, 'Port already in use. Identify its owner before changing the port or stopping a process.'],
      [/EACCES|EPERM/, 'Permission denied. Check config/runtime directory ownership and the service user.'],
      [/ORCHESTRATION_ALREADY_RUNNING/, 'Another orchestrator holds the instance lock. Do not delete the lock database; check the existing process.'],
      [/ConfigValidationError|No valid agents/, 'Startup config validation failed. Inspect gateway logs locally and correct the reported field.'],
      [/ENOENT|executable.*not found/, 'A runtime file or executable was missing. Check dependency results and service executable paths.'],
    ];
    for (const [pattern, detail] of hints) if (pattern.test(tail)) checks.push({ name: 'recentStartupLog', ok: true, info: true, detail: `${detail} Historical log match; may already be resolved.` });
  } catch { /* A fresh/down gateway need not have logs yet. */ }
  return checks;
}

/** Recover read access through a pinned descriptor, never a path-based chmod.
 * Linux O_PATH works even for mode 000; other platforms can recover write-only
 * files with O_WRONLY. Neither open truncates or writes configuration contents.
 */
function recoverConfigReadAccess(file: string): fs.Stats {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const linux = process.platform === 'linux';
  // Linux UAPI O_PATH is not exposed by Node's fs.constants.
  const descriptor = fs.openSync(file, (linux ? 0x200000 : fs.constants.O_WRONLY) | noFollow | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !process.getuid || stat.uid !== process.getuid()) {
      throw Object.assign(new Error(), { code: 'UNSAFE_CONFIG_OWNER_OR_TYPE' });
    }
    // O_PATH cannot be fchmod'ed. This proc link targets the pinned inode even
    // if the original name is replaced; do not substitute chmod(file).
    if (linux) fs.chmodSync(`/proc/self/fd/${descriptor}`, 0o600);
    else fs.fchmodSync(descriptor, 0o600);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) {
      throw Object.assign(new Error(), { code: 'CONFIG_CHANGED_RETRY' });
    }
    return stat;
  } finally { fs.closeSync(descriptor); }
}

/** Only repair files owned by this OS user; never follow a config symlink. */
export function repairStartup(file: string): StartupCheck[] {
  const actions: StartupCheck[] = [];
  let fd: number | undefined;
  try {
    // Descriptor operations cannot follow a symlink swapped after this open.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | fs.constants.O_NONBLOCK;
    let restoredReadAccess = false;
    try { fd = fs.openSync(file, flags); }
    catch (error) {
      if (errorCode(error) !== 'EACCES') throw error;
      const recovered = recoverConfigReadAccess(file);
      restoredReadAccess = true;
      actions.push({ name: 'configReadAccess', ok: true, detail: 'Restored owner read/write permissions (0600); contents unchanged. Creating a private content backup next.' });
      fd = fs.openSync(file, flags);
      const reopened = fs.fstatSync(fd);
      if (reopened.ino !== recovered.ino || reopened.dev !== recovered.dev) throw Object.assign(new Error(), { code: 'CONFIG_CHANGED_RETRY' });
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || fs.lstatSync(file).isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw Object.assign(new Error(), { code: 'UNSAFE_CONFIG_OWNER_OR_TYPE' });
    let raw = fs.readFileSync(fd, 'utf8');
    const assertUnchanged = () => {
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || fs.readFileSync(file, 'utf8') !== raw) throw Object.assign(new Error(), { code: 'CONFIG_CHANGED_RETRY' });
    };
    if (restoredReadAccess || (stat.mode & 0o777) !== 0o600) {
      fs.writeFileSync(`${file}.doctor-${randomUUID()}.bak`, raw, { mode: 0o600, flag: 'wx' });
      assertUnchanged();
      fs.fchmodSync(fd, 0o600);
      actions.push({ name: 'configPermissions', ok: true, detail: 'Backed up config and restored owner read/write permissions (0600).' });
    }
    if (raw.charCodeAt(0) === 0xfeff) {
      const stripped = raw.slice(1); JSON.parse(stripped);
      fs.writeFileSync(`${file}.doctor-bom-${randomUUID()}.bak`, raw, { mode: 0o600, flag: 'wx' });
      const temp = `${file}.doctor-${randomUUID()}.tmp`;
      let created = false;
      try {
        fs.writeFileSync(temp, stripped, { mode: 0o600, flag: 'wx' }); created = true;
        assertUnchanged();
        fs.renameSync(temp, file);
      } finally { if (created) { try { fs.unlinkSync(temp); } catch { /* renamed already */ } } }
      raw = stripped;
      actions.push({ name: 'configEncoding', ok: true, detail: 'Backed up config and removed UTF-8 BOM; all configuration values preserved.' });
    }
    const dir = resolvedLogDirectory(JSON.parse(raw));
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); actions.push({ name: 'logDirectory', ok: true, detail: `Created ${dir}` }); }
  } catch (error) { actions.push({ name: 'startupRepair', ok: false, detail: `Could not complete safe config repair (${errorCode(error)}). Correct JSON/ownership/environment manually; no credentials or agents were replaced.` }); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return actions;
}

export function inspectUserService(): StartupCheck[] {
  if (process.platform !== 'linux') return [];
  try {
    const output = execFileSync('systemctl', ['--user', 'show', 'claude-gateway.service', '--property=LoadState,ActiveState,Result'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    if (/LoadState=not-found/.test(output)) return [];
    const failed = /ActiveState=failed/.test(output);
    return [{ name: 'userService', ok: !failed, detail: failed ? 'User service failed. doctor fix resets the failure latch; then use service start. If executable paths changed, use service install to regenerate the unit.' : 'User service present; use service status for manager details.' }];
  } catch { return []; }
}
export function repairUserService(): StartupCheck[] {
  if (!inspectUserService().some(check => !check.ok)) return [];
  try { execFileSync('systemctl', ['--user', 'reset-failed', 'claude-gateway.service'], { timeout: 3000, stdio: 'ignore' }); return [{ name: 'userServiceRepair', ok: true, detail: 'Reset failed user-service state. No process was started/restarted. Run claude-gateway service start after remaining checks pass.' }]; }
  catch { return [{ name: 'userServiceRepair', ok: false, detail: 'Could not reset user service. Inspect systemctl --user status claude-gateway.service.' }]; }
}
