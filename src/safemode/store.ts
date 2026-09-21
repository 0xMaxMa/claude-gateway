import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type SafemodeCli = 'claude' | 'codex';
export interface SafemodeSession {
  id: string;
  name: string;
  cli: SafemodeCli;
  model: string;
  createdAt: string;
  nativeSessionId?: string;
  nativeStarted?: boolean;
  autoName?: boolean;
  /** Local operator assignment; never inferred from the first agent to call. */
  agentId?: string;
  configPath?: string;
  lastRequest?: { id: string; promptHash: string; status: 'running' | 'completed' | 'failed'; ownerToken?: string; result?: string; exitCode?: number; error?: string };
}
export interface Owner { token: string; pid: number; childPid?: number; launching?: boolean; mode: 'interactive' | 'headless' }
export function safemodeRoot(): string { return path.join(os.homedir(), '.claude-gateway', 'safemode'); }
export function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}
export function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try { process.kill(pid!, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class SafemodeStore {
  constructor(readonly root = safemodeRoot()) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Keep workspaces/socket paths stable, including for an older live supervisor.
    // Only rewrite idle legacy metadata under the same ownership lock.
    for (const { session } of this.records()) {
      if (!session.nativeSessionId || session.id === session.nativeSessionId || this.owner(session.id)) continue;
      let owner: Owner;
      try { owner = this.acquire(session.id, 'interactive'); } catch { continue; }
      const storageId = session.id;
      try { this.save(this.read(storageId)); } finally { this.release(storageId, owner); }
    }
  }
  private records(): Array<{ directory: string; session: SafemodeSession }> {
    return fs.readdirSync(this.root).filter(n => /^(starting-)?[a-f0-9-]{36}$/.test(n)).flatMap(key => {
      const directory = path.join(this.root, key);
      // Compatibility links preserve historical native cwd references, not records.
      try { if (fs.lstatSync(directory).isSymbolicLink()) return []; return [{ directory, session: JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8')) }]; }
      catch { return []; }
    });
  }
  dir(id: string): string {
    if (!/^(starting-)?[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid safemode ID');
    const matches = this.records().filter(r => r.session.nativeSessionId === id || r.session.id === id);
    if (matches.length > 1) throw new Error('Ambiguous native session ID');
    return matches[0]?.directory ?? path.join(this.root, id);
  }
  private canonical(session: SafemodeSession, directory: string, applyName = true): SafemodeSession {
    let renamed: string | undefined;
    try { if (applyName) renamed = JSON.parse(fs.readFileSync(path.join(directory, 'name.json'), 'utf8')).name; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Separate metadata prevents a running supervisor saving an older session
    // snapshot from undoing a local operator's assignment.
    let agentId: string | undefined;
    try { agentId = JSON.parse(fs.readFileSync(path.join(directory, 'access.json'), 'utf8')).agentId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    session = { ...session, agentId };
    if (renamed) session = { ...session, name: renamed, autoName: false };
    if (!session.nativeSessionId) return session;
    return { ...session, nativeSessionId: session.nativeSessionId.toLowerCase(), id: session.nativeSessionId.toLowerCase(), name: session.autoName || session.name === session.id ? session.nativeSessionId.toLowerCase() : session.name };
  }
  list(): SafemodeSession[] { return this.records().map(r => this.canonical(r.session, r.directory)); }
  read(id: string): SafemodeSession { const directory = this.dir(id); return this.canonical(JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8')), directory); }
  find(ref: string): SafemodeSession {
    const matches = this.list().filter(s => s.id === ref || s.name === ref);
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous safemode name; use native ID' : 'Safemode session not found');
    return matches[0];
  }
  assign(ref: string, agentId: string | null): SafemodeSession {
    if (agentId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(agentId)) throw new Error('Invalid agent ID');
    const session = this.find(ref);
    const owner = this.acquire(session.id, 'headless');
    try { atomicJson(path.join(this.dir(session.id), 'access.json'), { agentId }); }
    finally { this.release(session.id, owner); }
    return this.read(session.id);
  }
  rename(ref: string, name: string): SafemodeSession {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error('Name must contain 1-64 letters, digits, dots, underscores or hyphens');
    const session = this.find(ref);
    const directory = this.dir(session.id), storageKey = path.basename(directory);
    const lock = path.join(directory, 'renaming');
    const recovering = path.join(directory, 'recovering');
    if (fs.existsSync(recovering)) throw new Error('Busy: recovery in progress');
    const claim = lock + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(claim, JSON.stringify({pid:process.pid, name}), {flag:'wx',mode:0o600});
      // Publish complete ownership metadata atomically so recovery never sees
      // an empty lock if this short-lived CLI exits during rename.
      fs.linkSync(claim, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Busy: another rename is in progress');
      throw error;
    } finally { fs.rmSync(claim, {force:true}); }
    let reserved = false, committed = false;
    const reservation = path.join(this.root, 'names', name);
    try {
      if (fs.existsSync(recovering)) throw new Error('Busy: recovery in progress');
      const current = this.read(session.id);
      if (this.list().some(s => s.id !== current.id && (s.name === name || s.id === name))) throw new Error('Safemode name already exists');
      fs.mkdirSync(path.dirname(reservation), { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(reservation, storageKey, { flag: 'wx', mode: 0o600 }); reserved = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (fs.readFileSync(reservation, 'utf8') !== storageKey) throw new Error('Safemode name already exists');
      }
      // Separate metadata lets even an older live supervisor save progress
      // without overwriting a rename or losing its owner/native session state.
      atomicJson(path.join(directory, 'name.json'), { name });
      committed = true;
      if (current.name !== name) {
        const old = path.join(this.root, 'names', current.name);
        if (fs.existsSync(old) && fs.readFileSync(old, 'utf8') === storageKey) fs.unlinkSync(old);
      }
      return this.read(session.id);
    } finally {
      if (reserved && !committed) fs.rmSync(reservation, { force: true });
      fs.unlinkSync(lock);
    }
  }
  recoverRename(id: string): void {
    const directory = this.dir(id), lock = path.join(directory, 'renaming');
    let claim: {pid?: number; name?: string};
    try { claim = JSON.parse(fs.readFileSync(lock, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!Number.isInteger(claim.pid) || claim.pid! <= 0 || alive(claim.pid)) throw new Error('Rename owner is alive or cannot be verified');
    if (claim.name && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(claim.name) && this.read(id).name !== claim.name) {
      const reservation = path.join(this.root, 'names', claim.name);
      if (fs.existsSync(reservation) && fs.readFileSync(reservation, 'utf8') === path.basename(directory)) fs.unlinkSync(reservation);
    }
    fs.unlinkSync(lock);
  }
  save(session: SafemodeSession): void {
    const directory = this.dir(session.id);
    const canonical = this.canonical(session, directory, false);
    let saved: SafemodeSession | undefined;
    try { saved = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved?.nativeSessionId && saved.nativeSessionId.toLowerCase() !== canonical.nativeSessionId?.toLowerCase()) throw new Error('Cannot change the native session ID');
    // Renames own their alias file/reservations. Progress writers must not
    // replay a stale name or contend with another rename reusing that alias.
    if (saved && fs.existsSync(path.join(directory, 'name.json'))) {
      canonical.name = saved.name; canonical.autoName = saved.autoName;
    }
    const oldName = saved?.name ?? session.name;
    if (canonical.nativeSessionId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canonical.nativeSessionId)) throw new Error('Invalid native session ID');
      const bindings = path.join(this.root, 'native-bindings');
      fs.mkdirSync(bindings, { recursive: true, mode: 0o700 });
      const file = path.join(bindings, canonical.cli + '-' + canonical.id);
      const prior = this.records().find(r => r.directory !== directory && r.session.cli === canonical.cli && r.session.nativeSessionId?.toLowerCase() === canonical.id);
      if (prior) throw new Error('Native session already belongs to another safemode investigation');
      // The private storage key remains stable while Codex discovers its identity.
      const storageKey = path.basename(directory);
      try { fs.writeFileSync(file, storageKey, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (fs.readFileSync(file, 'utf8') !== storageKey) throw new Error('Native session already belongs to another safemode investigation');
      }
    }
    if (canonical.name !== oldName) {
      fs.mkdirSync(path.join(this.root, 'names'), { recursive: true, mode: 0o700 });
      const reservation = path.join(this.root, 'names', canonical.name);
      try { fs.writeFileSync(reservation, path.basename(directory), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.readFileSync(reservation, 'utf8') !== path.basename(directory)) throw error;
      }
    }
    atomicJson(path.join(directory, 'session.json'), canonical);
    if (canonical.name !== oldName) {
      const old = path.join(this.root, 'names', oldName);
      if (fs.existsSync(old) && fs.readFileSync(old, 'utf8') === path.basename(directory)) fs.unlinkSync(old);
    }
    Object.assign(session, this.canonical(canonical, directory));
  }
  create(name: string | undefined, cli: SafemodeCli, model: string, configPath?: string, nativeId?: string): SafemodeSession {
    if (nativeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)) throw new Error('Invalid native session ID');
    if (name && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || this.list().some(s => s.name === name || s.id === name))) {
      throw new Error('Safemode name must be unique and contain 1-64 letters, digits, dots, underscores or hyphens');
    }
    // Claude accepts a caller-generated UUID. Codex assigns its own ID later.
    const id = nativeId?.toLowerCase() || (cli === 'claude' ? randomUUID() : 'starting-' + randomUUID());
    const session: SafemodeSession = { id, name: name || (id.startsWith('starting-') ? 'codex-starting-' + Date.now() + '-' + process.pid : id), autoName: !name, cli, model, createdAt: new Date().toISOString(), configPath,
      nativeSessionId: id.startsWith('starting-') ? undefined : id, nativeStarted: !!nativeId };
    const names = path.join(this.root, 'names');
    fs.mkdirSync(names, { recursive: true, mode: 0o700 });
    const reservation = path.join(names, session.name);
    try { fs.writeFileSync(reservation, id, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Safemode name already exists'); throw e; }
    let created = false;
    try {
      fs.mkdirSync(this.dir(id), { mode: 0o700 }); created = true;
      fs.mkdirSync(path.join(this.dir(id), 'workspace'), { mode: 0o700 });
      this.save(session);
      return session;
    } catch (error) {
      if (created) { this.removeName(session); fs.rmSync(this.dir(id), { recursive: true, force: true }); }
      else fs.rmSync(reservation, { force: true });
      throw error;
    }
  }
  removeName(session: SafemodeSession): void {
    if (session.nativeSessionId) {
      const binding = path.join(this.root, 'native-bindings', session.cli + '-' + session.nativeSessionId.toLowerCase());
      if (fs.existsSync(binding) && fs.readFileSync(binding, 'utf8') === path.basename(this.dir(session.id))) fs.unlinkSync(binding);
    }
    const file = path.join(this.root, 'names', session.name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === path.basename(this.dir(session.id))) fs.unlinkSync(file);
  }
  /** Call only after native ownership checks and while holding this session's lock. */
  alignStorage(id: string, owner: Owner): void {
    const session = this.read(id), directory = this.dir(id);
    if (!session.nativeSessionId || path.basename(directory) === session.nativeSessionId) return;
    const current = this.owner(id);
    if (current?.token !== owner.token || current.pid !== process.pid || alive(current.childPid)) throw new Error('Workspace alignment requires exclusive ownership and an exited native process');
    if (fs.existsSync(path.join(directory, 'recovering'))) throw new Error('Busy: recovery in progress');
    const destination = path.join(this.root, session.nativeSessionId);
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Native workspace destination already exists');
    // Renaming an alias is allowed during execution, so serialize it separately.
    const lock = path.join(directory, 'renaming');
    const claim = lock + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(claim, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      fs.linkSync(claim, lock);
    } finally { fs.rmSync(claim, { force: true }); }
    let moved = false;
    const reservations: string[] = [];
    const storageKey = path.basename(directory);
    try {
      for (const subdir of ['names', 'native-bindings']) {
        const root = path.join(this.root, subdir);
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
          const file = path.join(root, name);
          if (fs.readFileSync(file, 'utf8') === storageKey) reservations.push(file);
        }
      }
      fs.renameSync(directory, destination); moved = true;
      // Native rollout history may still refer to the original cwd. Do not edit it.
      fs.symlinkSync(session.nativeSessionId, directory, 'dir');
      for (const file of reservations) fs.writeFileSync(file, session.nativeSessionId, { mode: 0o600 });
    } catch (error) {
      if (moved) {
        if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(directory);
        fs.renameSync(destination, directory);
        for (const file of reservations) fs.writeFileSync(file, storageKey, { mode: 0o600 });
      }
      throw error;
    } finally { fs.unlinkSync(path.join(moved && fs.existsSync(destination) ? destination : directory, 'renaming')); }
  }
  owner(id: string): Owner | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'owner.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Busy: safemode ownership cannot be verified'); }
  }
  acquire(id: string, mode: Owner['mode']): Owner {
    const file = path.join(this.dir(id), 'owner.json');
    const recovery = path.join(this.dir(id), 'recovering');
    if (fs.existsSync(recovery)) throw new Error('Busy: recovery in progress');
    // No automatic stale-lock deletion: deleting a stale path races another
    // claimant. Recovery is explicit and only performed under the recovery lock.
    const owner = { token: randomUUID(), pid: process.pid, mode };
    try { fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Busy: safemode has an owner; stop it or recover a stale owner'); throw e; }
    if (fs.existsSync(recovery)) { this.release(id, owner); throw new Error('Busy: recovery in progress'); }
    return owner;
  }
  updateOwner(id: string, owner: Owner): void {
    if (this.owner(id)?.token !== owner.token) throw new Error('Safemode ownership lost');
    atomicJson(path.join(this.dir(id), 'owner.json'), owner);
  }
  release(id: string, owner: Owner): void {
    if (this.owner(id)?.token === owner.token) fs.unlinkSync(path.join(this.dir(id), 'owner.json'));
  }
}
