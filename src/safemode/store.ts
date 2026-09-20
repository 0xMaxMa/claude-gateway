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
  configPath?: string;
  lastRequest?: { id: string; promptHash: string; status: 'running' | 'completed' | 'failed'; exitCode?: number };
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
  constructor(readonly root = safemodeRoot()) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  dir(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid safemode ID');
    return path.join(this.root, id);
  }
  list(): SafemodeSession[] {
    return fs.readdirSync(this.root).filter(n => /^[a-f0-9-]{36}$/.test(n)).flatMap(id => {
      try { return [this.read(id)]; } catch { return []; }
    });
  }
  read(id: string): SafemodeSession { return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'session.json'), 'utf8')); }
  find(ref: string): SafemodeSession {
    const matches = this.list().filter(s => s.id === ref || s.name === ref);
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous safemode name; use ID' : 'Safemode session not found');
    return matches[0];
  }
  save(session: SafemodeSession): void { atomicJson(path.join(this.dir(session.id), 'session.json'), session); }
  create(name: string | undefined, cli: SafemodeCli, model: string, configPath?: string): SafemodeSession {
    if (name && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || this.list().some(s => s.name === name))) {
      throw new Error('Safemode name must be unique and contain 1-64 letters, digits, dots, underscores or hyphens');
    }
    const id = randomUUID();
    const session: SafemodeSession = { id, name: name || id, cli, model, createdAt: new Date().toISOString(), configPath };
    const names = path.join(this.root, 'names');
    fs.mkdirSync(names, { recursive: true, mode: 0o700 });
    const reservation = path.join(names, session.name);
    try { fs.writeFileSync(reservation, id, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Safemode name already exists'); throw e; }
    try {
      fs.mkdirSync(this.dir(id), { mode: 0o700 });
      fs.mkdirSync(path.join(this.dir(id), 'workspace'), { mode: 0o700 });
      this.save(session);
      return session;
    } catch (error) { fs.rmSync(reservation, { force: true }); throw error; }
  }
  removeName(session: SafemodeSession): void {
    const file = path.join(this.root, 'names', session.name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === session.id) fs.unlinkSync(file);
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
