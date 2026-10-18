import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspaceRecomposer } from '../../src/agent/workspace-loader';
import type { LoadedWorkspace } from '../../src/types';

describe('workspaceRecomposer', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recompose-')); });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const loaded = (systemPrompt: string) => ({ systemPrompt, skillRegistry: { skills: new Map() } }) as unknown as LoadedWorkspace;

  it('runs one recompose at a time: a slow older load never overwrites a newer CLAUDE.md', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loads: string[] = [];
    const applied: string[] = [];
    let n = 0;
    const recompose = workspaceRecomposer(
      ws,
      async () => {
        const id = ++n === 1 ? 'stale' : 'fresh';
        loads.push(`start:${id}`);
        if (id === 'stale') await gate; // e.g. a skills-watcher load that read skill_stats before a use was counted
        loads.push(`end:${id}`);
        return loaded(id);
      },
      (u) => applied.push(u.systemPrompt),
    );
    const first = recompose();
    const second = recompose(); // refreshMenu after the use was counted
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, second]);
    expect(loads).toEqual(['start:stale', 'end:stale', 'start:fresh', 'end:fresh']);
    expect(applied).toEqual(['stale', 'fresh']);
    expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('fresh');
  });

  it('a failed recompose rejects its caller but does not block the next one', async () => {
    let fail = true;
    const recompose = workspaceRecomposer(ws, async () => { if (fail) { fail = false; throw new Error('boom'); } return loaded('ok'); }, () => {});
    await expect(recompose()).rejects.toThrow('boom');
    await expect(recompose()).resolves.toMatchObject({ systemPrompt: 'ok' });
    expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('ok');
  });

  it('a recompose for a replaced runner writes nothing and applies nothing', async () => {
    let current = true;
    const applied: string[] = [];
    const recompose = workspaceRecomposer(ws, async () => { current = false; return loaded('old-mode'); }, (u) => applied.push(u.systemPrompt), () => current);
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'new-runner', 'utf8');
    await recompose();
    expect(applied).toEqual([]);
    expect(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('new-runner');
  });
});
