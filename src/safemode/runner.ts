import { codexSafemodeEnvironment } from '../session/codex-auth';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { SafemodeStore, SafemodeSession, Owner, alive, atomicJson } from './store';
import { buildNativeInvocation, discoverCodexSession, extractNativeSessionId } from './native';
import { prepareContext } from './context';
import { assertNoExternalNativeOwner } from './external-owners';

export interface RunOptions { nativeArgs?: string[]; nativeResumeIndex?: number; mode: 'interactive' | 'headless'; prompt?: string; requestId?: string; configPath?: string }
const STOP_TIMEOUT = 15000;
export function controlPath(store: SafemodeStore, id: string): string {
  // A bounded socket path also supports long HOME paths on macOS/Linux.
  return path.join(store.root, `${path.basename(store.dir(id))}.sock`);
}
export async function stopSession(store: SafemodeStore, id: string, expectedOwner?: Owner): Promise<void> {
  const current = store.owner(id);
  if (!current) return;
  const expected = expectedOwner ?? current;
  if (current.token !== expected.token) throw new Error('Busy: safemode owner changed; stop request refused');
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(controlPath(store, id));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Owner did not stop; no replacement was launched')); }, STOP_TIMEOUT);
    let response = '';
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'stop', ownerToken: expected.token }) + '\n'));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('Owner cannot be reached; use safemode recover only after its processes exit')); });
    socket.on('end', () => { clearTimeout(timer); response.trim() === 'stopped' ? resolve() : reject(new Error(response.trim() === 'owner-changed' ? 'Busy: safemode owner changed; stop request refused' : 'Owner refused to stop')); });
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
    store.recoverRename(id);
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
  let ownershipMonitor: NodeJS.Timeout | undefined;
  let ownershipError: string | undefined;
  let request: SafemodeSession['lastRequest'];
  let exitCode = 1;
  const startedAt = Date.now();
  try {
    // Read current state only after exclusive ownership, avoiding stale saves.
    const latest = store.read(session.id);
    session = { ...latest, model: session.model, configPath: options.configPath ?? session.configPath };
    assertNoExternalNativeOwner({ cli: session.cli, nativeSessionId: session.nativeSessionId, cwd: workspace });
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
        if (data.length > 256) { socket.destroy(); return; }
        if (!data.endsWith('\n')) return;
        try {
          const command = JSON.parse(data);
          if (command.action !== 'stop' || command.ownerToken !== owner.token) { socket.end('owner-changed\n'); return; }
          stopClients.add(socket); stop();
        } catch { socket.end('invalid-command\n'); }
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
      nativeArgs: options.nativeArgs, nativeResumeIndex: options.nativeResumeIndex, prompt: options.prompt, context, model: session.model, nativeSessionId: session.nativeSessionId, resume: !!session.nativeSessionId && session.nativeStarted !== false });
    if (session.cli === 'codex') invocation.env = await codexSafemodeEnvironment(invocation.command, invocation.env, { nativeArgs: options.nativeArgs });
    if (stopping) throw new Error('Stopped during native CLI readiness check');
    if (invocation.nativeSessionId) session.nativeSessionId = invocation.nativeSessionId;
    store.save(session);
    process.stderr.write(`Safemode ${session.id.startsWith('starting-') ? 'starting (waiting for native session ID)' : session.name}: ${session.cli}, model ${session.model === 'inherit' ? 'inherited from native CLI' : session.model}\n`);
    assertNoExternalNativeOwner({ cli: session.cli, nativeSessionId: session.nativeSessionId, cwd: workspace, env: invocation.env });
    owner.launching = true;
    store.updateOwner(session.id, owner);
    child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env,
      stdio: options.mode === 'interactive' ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    completion = new Promise(resolve => {
      let error: Error | undefined;
      child!.once('error', value => { error = value; });
      child!.once('close', code => { childClosed = true; resolve({ code: code ?? 1, error }); });
    });
    child.once('spawn', () => {
      try {
        session.nativeStarted = true; store.save(session);
        if (process.connected) process.send?.({ ready: true, sessionId: session.id.startsWith('starting-') ? null : session.id, requestId: options.requestId });
      } catch (error) { ownershipError = (error as Error).message; child?.kill('SIGTERM'); }
    });
    owner.childPid = child.pid;
    owner.launching = false;
    store.updateOwner(session.id, owner);
    const captureId = (id: string | undefined) => {
      if (!id || id === session.nativeSessionId) return;
      try {
        if (session.nativeSessionId) throw new Error('Native CLI returned a different session ID');
        const identified = { ...session, nativeSessionId: id, nativeStarted: true };
        store.save(identified); Object.assign(session, identified);
        process.stderr.write(`Safemode session: ${session.id}\n`);
      } catch (error) { ownershipError = (error as Error).message; child?.kill('SIGTERM'); }
    };
    if (session.cli === 'codex' && options.mode === 'interactive' && !session.nativeSessionId) {
      const discover = () => { try { captureId(discoverCodexSession({ cwd: workspace, startedAt })); } catch { /* Ambiguous discovery must not guess. */ } };
      discovery = setInterval(discover, 1000);
    }
    let buffered = '';
    let logBytes = 0;
    const logFile = path.join(store.dir(session.id), 'output.log');
    if (options.mode === 'headless') fs.writeFileSync(logFile, '', { mode: 0o600 });
    const maxLogBytes = 5 * 1024 * 1024;
    const appendOutput = (chunk: Buffer) => {
      if (logBytes + chunk.length > maxLogBytes) {
        // Compact in large batches, retaining the newest output rather than
        // dropping the final diagnosis once verbose tool events fill the log.
        const previous = fs.readFileSync(logFile);
        const tail = Buffer.concat([previous.subarray(-Math.floor(maxLogBytes / 2)), chunk]).subarray(-maxLogBytes);
        fs.writeFileSync(logFile, tail); logBytes = tail.length;
      } else { fs.appendFileSync(logFile, chunk); logBytes += chunk.length; }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.length > 1024 * 1024) buffered = '';
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        captureId(extractNativeSessionId(session.cli, line));
      }
      appendOutput(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendOutput(chunk);
    });
    ownershipMonitor = setInterval(() => {
      if (childClosed || ownershipError) return;
      try {
        assertNoExternalNativeOwner({ cli: session.cli, nativeSessionId: session.nativeSessionId, cwd: workspace,
          env: invocation.env, ignorePids: child?.pid ? [child.pid] : [] });
      } catch (error) {
        ownershipError = (error as Error).message;
        // Only our ChildProcess handle is signalled. External/native owners are
        // never killed based on PIDs found in registries or /proc.
        child?.kill('SIGTERM');
        const notice = `Stopping safemode: ${ownershipError}\n`;
        process.stderr.write(notice);
        if (options.mode === 'headless') appendOutput(Buffer.from(notice));
      }
    }, 1000);
    const result = await completion;
    exitCode = ownershipError ? 1 : result.code;
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
    if (ownershipMonitor) clearInterval(ownershipMonitor);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
    process.removeListener('SIGINT', stop);
    if (request) {
      request.status = exitCode === 0 ? 'completed' : 'failed'; request.exitCode = exitCode;
      if (ownershipError) request.error = ownershipError;
      atomicJson(requestFile(store, session.id, request.id), request);
      session.lastRequest = request; store.save(session);
    }
    server?.close();
    fs.rmSync(controlPath(store, session.id), { force: true });
    if (canRelease) store.release(session.id, owner);
    for (const socket of stopClients) socket.end(canRelease ? 'stopped\n' : 'still-running\n');
  }
}
