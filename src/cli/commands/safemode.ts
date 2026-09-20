import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { SafemodeStore, alive } from '../../safemode/store';
import { resolveSafemodeSettings, resolveSafemodeConfigPath } from '../../safemode/config';
import { getRequest, recoverSession, runSession, stopSession } from '../../safemode/runner';
import { unknownFlagNames } from '../args';
import { assertNoExternalNativeOwner, findExternalNativeOwners } from '../../safemode/external-owners';
import { SafemodeSession } from '../../safemode/store';
import { inspectNativeParams, splitNativeParams } from '../../safemode/params';
import { redactLine } from '../redact';

const HELP = `Usage: claude-gateway safemode [--name NAME] [--cli claude|codex] [--model MODEL] [--prompt TEXT] [--params NATIVE_ARGS]
       claude-gateway safemode --resume NAME_OR_ID [--takeover] [--prompt TEXT]
       claude-gateway safemode list
       claude-gateway safemode status NAME_OR_ID [--request-id ID]
       claude-gateway safemode send NAME_OR_ID --prompt TEXT [--request-id ID] [--takeover] [--wait]
       claude-gateway safemode logs|stop|delete|recover NAME_OR_ID

--params is interactive-only, parsed as argv without shell evaluation. Native resume requires a UUID.
Do not combine native resume in --params with safemode --resume.
Default: native interactive Claude Code, inheriting its configured model.
--resume accepts the native Claude Code/Codex session ID or a saved name. Put gateway chat IDs in --prompt.
Headless send runs in the background; --wait waits for its result. There is no job queue.
Takeover gracefully stops the previous owner before resuming the same native conversation.
Use recover only for stale ownership after both supervisor and native CLI have exited.
Config: safemode.cli and safemode.claude.model / safemode.codex.model (default: inherit).
`;
function nativeOwnership(store: SafemodeStore, session: SafemodeSession): object {
  try { return { nativeOwners: findExternalNativeOwners({ cli: session.cli, nativeSessionId: session.nativeSessionId, cwd: path.join(store.dir(session.id), 'workspace') }) }; }
  catch (error) { return { nativeOwnershipError: (error as Error).message }; }
}
function publicId(session: SafemodeSession): string | null { return session.id.startsWith('starting-') ? null : session.id; }
function publicSession(session: SafemodeSession): object {
  const { nativeSessionId, autoName, ...rest } = session;
  const starting = session.id.startsWith('starting-');
  return { ...rest, id: starting ? null : session.id, name: session.name,
    ...(starting ? { status: 'starting', detail: 'Waiting for native session ID' } : {}) };
}
function output(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

export async function runSafemode(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  if (flags.help) { process.stdout.write(HELP); return 0; }
  const verb = positionals[0] || 'open';
  const common = ['help', 'json', 'config'];
  const allowed: Record<string, string[]> = {
    open: ['name', 'cli', 'model', 'prompt', 'resume', 'takeover', 'params'], list: [],
    status: ['request-id'], logs: [], stop: [], delete: [], recover: [],
    send: ['prompt', 'request-id', 'takeover', 'wait', 'model'],
  };
  if (!allowed[verb]) throw new Error('Unknown safemode command');
  const unknown = unknownFlagNames(flags, new Set([...common, ...allowed[verb]]));
  if (unknown.length) throw new Error(`Unknown safemode flag(s): ${unknown.map(n => '--' + n).join(', ')}`);
  for (const key of ['name', 'cli', 'model', 'prompt', 'resume', 'request-id', 'config', 'params']) {
    if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !(flags[key] as string).trim())) throw new Error(`--${key} requires a value`);
  }
  if (typeof flags.prompt === 'string' && flags.prompt.length > 100000) throw new Error('Prompt exceeds 100000 characters');
  const store = new SafemodeStore();
  if (verb === 'list') {
    if (positionals.length !== 1) throw new Error('Unexpected safemode list argument');
    output(store.list().map(s => ({ ...publicSession(s), owner: store.owner(s.id), ...nativeOwnership(store, s) }))); return 0;
  }
  if (verb === 'open') {
    if (positionals.length > (positionals[0] === 'open' ? 1 : 0)) throw new Error('Unexpected safemode argument');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive safemode requires a terminal; use safemode send for headless execution');
    const previous = typeof flags.resume === 'string' ? store.find(flags.resume) : undefined;
    if (previous && flags.name) throw new Error('--name cannot rename a resumed investigation');
    const settings = resolveSafemodeSettings(flags, previous);
    const native = typeof flags.params === 'string' ? inspectNativeParams(settings.cli, splitNativeParams(flags.params)) : undefined;
    if (previous && native?.resumeId) throw new Error('Do not combine safemode --resume with native resume in --params');
    if (native?.resumeId) {
      const bound = store.list().find(s => s.cli === settings.cli && s.nativeSessionId?.toLowerCase() === native.resumeId);
      if (bound) throw new Error('Native session already belongs to a safemode investigation; use safemode --resume ' + bound.id);
      assertNoExternalNativeOwner({ cli: settings.cli, nativeSessionId: native.resumeId, cwd: store.root });
    }
    const configPath = resolveSafemodeConfigPath(flags, previous);
    const session = previous ? { ...previous, ...settings, configPath } : store.create(flags.name as string | undefined, settings.cli, settings.model, configPath, native?.resumeId);
    if (previous) {
      if (store.owner(session.id)) {
        if (!flags.takeover) throw new Error('Busy: use --takeover to stop the current owner first');
        await stopSession(store, session.id);
      }
      const refreshed = store.read(session.id);
      if (!refreshed.nativeSessionId) throw new Error('Native conversation ID is not available; refusing to start a different conversation');
      session.nativeSessionId = refreshed.nativeSessionId;
    }
    return runSession(store, session, { mode: 'interactive', nativeArgs: native?.args, prompt: flags.prompt as string | undefined, configPath: session.configPath });
  }
  if (positionals.length !== 2) throw new Error(`safemode ${verb} requires one session name or ID`);
  const session = store.find(positionals[1]);
  if (verb === 'status') {
    const owner = store.owner(session.id);
    output({ ...publicSession(session), ...nativeOwnership(store, session), owner, ownerAlive: owner ? alive(owner.pid) : false,
      request: typeof flags['request-id'] === 'string' ? getRequest(store, session.id, flags['request-id']) ?? null : session.lastRequest }); return 0;
  }
  if (verb === 'logs') {
    const file = path.join(store.dir(session.id), 'output.log');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-65536).split('\n').map(redactLine).join('\n') : '';
    output({ id: publicId(session), output: text }); return 0;
  }
  if (verb === 'stop') { await stopSession(store, session.id); output({ id: publicId(session), stopped: true }); return 0; }
  if (verb === 'recover') { recoverSession(store, session.id); output({ id: publicId(session), recovered: true }); return 0; }
  if (verb === 'delete') {
    const owner = store.acquire(session.id, 'headless');
    try { const directory = store.dir(session.id); store.removeName(session); fs.rmSync(directory, { recursive: true }); }
    catch (e) { store.release(session.id, owner); throw e; }
    output({ id: publicId(session), deleted: true }); return 0;
  }
  if (typeof flags.prompt !== 'string') throw new Error('safemode send requires --prompt');
  const requestId = typeof flags['request-id'] === 'string' ? flags['request-id'] : randomUUID();
  // Validate request ID before launching a worker or stopping a live owner.
  const priorRequest = getRequest(store, session.id, requestId);
  const settings = resolveSafemodeSettings(flags, session);
  if (priorRequest) {
    const hash = createHash('sha256').update(JSON.stringify([flags.prompt, settings.cli, settings.model])).digest('hex');
    if (hash !== priorRequest.promptHash) throw new Error('Request ID was already used with different input');
    output({ id: publicId(session), requestId, duplicate: true, request: priorRequest });
    return 0;
  }
  const currentOwner = store.owner(session.id);
  if (currentOwner) {
    if (currentOwner.mode === 'headless') throw new Error('Busy: a headless request is already running; inspect status or stop it explicitly');
    if (!flags.takeover) throw new Error('Busy: use --takeover to stop the current owner first');
    await stopSession(store, session.id);
  }
  const refreshed = { ...store.read(session.id), ...settings, configPath: resolveSafemodeConfigPath(flags, session) };
  if (!refreshed.nativeSessionId || refreshed.nativeStarted === false) throw new Error('Native conversation ID is not available; refusing to start a different conversation');
  Object.assign(session, refreshed);
  assertNoExternalNativeOwner({ cli: refreshed.cli, nativeSessionId: refreshed.nativeSessionId, cwd: path.join(store.dir(session.id), 'workspace') });
  if (flags.wait) return runSession(store, refreshed, { mode: 'headless', prompt: flags.prompt, requestId, configPath: refreshed.configPath });
  const args = [path.resolve(__dirname, '../../entry.js'), 'safemode', 'send', session.id, `--prompt=${flags.prompt}`, `--request-id=${requestId}`, '--wait'];
  if (flags.model) args.push('--model', flags.model as string);
  args.push('--config=' + refreshed.configPath);
  const log = fs.openSync(path.join(store.dir(session.id), 'supervisor.log'), 'w', 0o600);
  let worker: ReturnType<typeof spawn>;
  try { worker = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log, 'ipc'] }); }
  finally { fs.closeSync(log); }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Worker may still be preparing diagnostics: don't pretend acceptance is
      // failure and submit again. Status/request ID gives the durable outcome.
      worker.disconnect(); worker.unref();
      output({ id: publicId(session), requestId, status: 'starting', message: 'Check status with this request ID' }); resolve();
    }, 20000);
    worker.once('error', err => { clearTimeout(timer); reject(err); });
    worker.once('message', message => {
      if (!(message as {ready?: boolean}).ready) return;
      clearTimeout(timer); worker.disconnect(); worker.unref();
      output({ id: publicId(session), requestId, status: 'accepted' }); resolve();
    });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Headless startup failed; inspect safemode status and local supervisor.log'));
    });
  });
  return 0;
}
