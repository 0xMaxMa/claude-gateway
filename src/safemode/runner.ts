import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { SafemodeStore, SafemodeSession, Owner, alive, atomicJson } from './store';
import { buildNativeInvocation, discoverCodexSession, extractNativeSessionId } from './native';
import { prepareContext } from './context';

export interface RunOptions { nativeArgs?: string[]; mode: 'interactive' | 'headless'; prompt?: string; requestId?: string; configPath?: string }
const STOP_TIMEOUT = 15000;
export function controlPath(store: SafemodeStore, id: string): string {
  // A bounded socket path also supports long HOME paths on macOS/Linux.
  return path.join(store.root, `${id}.sock`);
}
export async function stopSession(store: SafemodeStore, id: string): Promise<void> {
  if (!store.owner(id)) return;
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(controlPath(store, id));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Owner did not stop; no replacement was launched')); }, STOP_TIMEOUT);
    let response = '';
    socket.on('connect', () => socket.write('stop\n'));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('Owner cannot be reached; use safemode recover only after its processes exit')); });
    socket.on('end', () => { clearTimeout(timer); response.trim() === 'stopped' ? resolve() : reject(new Error('Owner refused to stop')); });
  });
}
export function recoverSession(store: SafemodeStore, id: string): void {
  // Serialize recovery with an exclusive file. A claimant never deletes this
  // marker; acquire checks it, so it cannot claim while recovery removes state.
  const recovery = path.join(store.dir(id), 'recovering');
  const fd = fs.openSync(recovery, 'wx', 0o600);
  try {
    const owner = store.owner(id);
    if (owner?.launching) throw new Error('Native launch outcome is unknown; verify its processes manually before repairing ownership');
    if (owner && (alive(owner.pid) || alive(owner.childPid))) throw new Error('Owner or native CLI is still alive; recovery refused');
    if (owner) store.release(id, owner);
    fs.rmSync(controlPath(store, id), { force: true });
  } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
}
function requestFile(store: SafemodeStore, id: string, requestId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(requestId)) throw new Error('Invalid request ID');
  return path.join(store.dir(id), 'requests', `${requestId}.json`);
}
export function getRequest(store: SafemodeStore, id: string, requestId: string): SafemodeSession['lastRequest'] {
  const file = requestFile(store, id, requestId);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function runSession(store: SafemodeStore, session: SafemodeSession, options: RunOptions): Promise<number> {
  if (options.nativeArgs !== undefined && options.mode !== 'interactive') throw new Error('Native params are interactive-only');
  const owner = store.acquire(session.id, options.mode);
  const workspace = path.join(store.dir(session.id), 'workspace');
  let server: net.Server | undefined;
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed = false;
  let completion: Promise<{code: number; error?: Error}> | undefined;
  const stopClients = new Set<net.Socket>();
  const stop = () => {
    stopping = true;
    if (options.mode === 'interactive') process.stderr.write('\nSafemode is stopping for an external stop/takeover request.\n');
    child?.kill('SIGTERM');
  };
  let discovery: NodeJS.Timeout | undefined;
  let request: SafemodeSession['lastRequest'];
  let exitCode = 1;
  const startedAt = Date.now();
  try {
    // Read current state only after exclusive ownership, avoiding stale saves.
    const latest = store.read(session.id);
    session = { ...latest, model: session.model, configPath: options.configPath ?? session.configPath };
    if (options.requestId) {
      const promptHash = createHash('sha256').update(JSON.stringify([options.prompt, session.cli, session.model])).digest('hex');
      const existing = getRequest(store, session.id, options.requestId);
      if (existing) {
        if (existing.promptHash !== promptHash) throw new Error('Request ID was already used with different input');
        if (existing.status === 'running') throw new Error('Request outcome is unknown; inspect status before submitting a new request ID');
        process.connected && process.send?.({ ready: true, sessionId: session.id, requestId: existing.id, duplicate: true });
        return existing.exitCode ?? 1;
      }
      request = { id: options.requestId, promptHash, status: 'running' };
      fs.mkdirSync(path.dirname(requestFile(store, session.id, request.id)), { recursive: true, mode: 0o700 });
      atomicJson(requestFile(store, session.id, request.id), request);
      session.lastRequest = request;
      store.save(session);
    }
    server = net.createServer(socket => {
      socket.setTimeout(STOP_TIMEOUT, () => socket.destroy());
      let data = '';
      socket.on('data', chunk => {
        data += chunk.toString();
        if (data.length > 32) { socket.destroy(); return; }
        if (data === 'stop\n') { stopClients.add(socket); stop(); }
      });
      socket.on('error', () => {});
      socket.on('close', () => stopClients.delete(socket));
    });
    fs.rmSync(controlPath(store, session.id), { force: true });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(controlPath(store, session.id), resolve); });
    fs.chmodSync(controlPath(store, session.id), 0o600);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
    process.on('SIGINT', stop);
    const { prompt: context } = await prepareContext(workspace, session.configPath, options.prompt);
    if (stopping) throw new Error('Stopped before native CLI launch');
    const invocation = await buildNativeInvocation({ cli: session.cli, mode: options.mode, cwd: workspace,
      nativeArgs: options.nativeArgs, prompt: options.prompt, context, model: session.model, nativeSessionId: session.nativeSessionId, resume: !!session.nativeSessionId });
    if (invocation.nativeSessionId) session.nativeSessionId = invocation.nativeSessionId;
    store.save(session);
    process.stderr.write(`Safemode ${session.name}: ${session.cli}, model ${session.model === 'inherit' ? 'inherited from native CLI' : session.model}\n`);
    owner.launching = true;
    store.updateOwner(session.id, owner);
    child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env,
      stdio: options.mode === 'interactive' ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    completion = new Promise(resolve => {
      let error: Error | undefined;
      child!.once('error', value => { error = value; });
      child!.once('close', code => { childClosed = true; resolve({ code: code ?? 1, error }); });
    });
    child.once('spawn', () => { if (process.connected) process.send?.({ ready: true, sessionId: session.id, requestId: options.requestId }); });
    owner.childPid = child.pid;
    owner.launching = false;
    store.updateOwner(session.id, owner);
    const captureId = (id: string | undefined) => {
      if (id && id !== session.nativeSessionId) { session.nativeSessionId = id; store.save(session); }
    };
    if (session.cli === 'codex' && options.mode === 'interactive' && !session.nativeSessionId) {
      const discover = () => { try { captureId(discoverCodexSession({ cwd: workspace, startedAt })); } catch { /* Ambiguous discovery must not guess. */ } };
      discovery = setInterval(discover, 1000);
    }
    let buffered = '';
    let logBytes = 0;
    const logFile = path.join(store.dir(session.id), 'output.log');
    if (options.mode === 'headless') fs.writeFileSync(logFile, '', { mode: 0o600 });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.length > 1024 * 1024) buffered = '';
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        captureId(extractNativeSessionId(session.cli, line));
      }
      if (logBytes < 5 * 1024 * 1024) { fs.appendFileSync(logFile, chunk); logBytes += chunk.length; }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (logBytes < 5 * 1024 * 1024) { fs.appendFileSync(logFile, chunk); logBytes += chunk.length; }
    });
    const result = await completion;
    exitCode = result.code;
    if (result.error) throw result.error;
    if (session.cli === 'codex' && !session.nativeSessionId) {
      try { captureId(discoverCodexSession({ cwd: workspace, startedAt })); } catch { /* No guessed conversation identity. */ }
    }
    return exitCode;
  } finally {
    if (child && !childClosed && completion) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, STOP_TIMEOUT);
        completion!.then(() => { clearTimeout(timeout); resolve(); });
      });
    }
    const canRelease = !child || childClosed;
    if (discovery) clearInterval(discovery);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
    process.removeListener('SIGINT', stop);
    if (request) {
      request.status = exitCode === 0 ? 'completed' : 'failed'; request.exitCode = exitCode;
      atomicJson(requestFile(store, session.id, request.id), request);
      session.lastRequest = request; store.save(session);
    }
    server?.close();
    fs.rmSync(controlPath(store, session.id), { force: true });
    if (canRelease) store.release(session.id, owner);
    for (const socket of stopClients) socket.end(canRelease ? 'stopped\n' : 'still-running\n');
  }
}
