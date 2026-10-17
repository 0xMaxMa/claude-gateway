/**
 * Per-conversation sandboxes for isolated app agents (#609): what one conversation's
 * container can see of the workspace, and the inspection gate that refuses anything
 * wider before a session executes there.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sandboxContainerName, sandboxMounts, sandboxCreateArgs, workspaceEntryVisible, usesConversationSandbox, SANDBOX_LABEL,
} from '../../src/apps/conversation-sandbox';
import { validateContainerInspection } from '../../src/orchestration/container';
import { chatMemoryDirName } from '../../src/agent/workspace-loader';
import type { AgentConfig } from '../../src/types';

let root: string;
let ws: string;
let agent: AgentConfig;
const A = { source: 'telegram', chatId: '111' };
const B = { source: 'telegram', chatId: '222' };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-')));
  ws = path.join(root, 'app', 'agent');
  for (const dir of ['skills', 'memory', 'chats/' + chatMemoryDirName('telegram', '222'), '.telegram-state', '.sessions/s-b', '.claude/skills', '.claude/agent-memory', 'tools']) fs.mkdirSync(path.join(ws, dir), { recursive: true });
  for (const [file, text] of Object.entries({
    'CLAUDE.md': 'composed', 'AGENTS.md': 'persona', 'SOUL.md': 'tone', 'MEMORY.md': 'ROOT-MEMORY', 'USER.md': 'ROOT-USER',
    'SKILLS_LEARNED.md': 'diary', 'kb.sqlite': '', 'kb.sqlite-wal': '', [`chats/${chatMemoryDirName('telegram', '222')}/MEMORY.md`]: 'CHAT-B',
  })) fs.writeFileSync(path.join(ws, file), text);
  fs.symlinkSync('/etc', path.join(ws, 'host-etc'));
  // A root note an agent wrote before isolate mode, about one user.
  fs.writeFileSync(path.join(ws, 'notes-about-alice.md'), 'ALICE');
  fs.mkdirSync(path.join(ws, 'odd,name'));
  fs.mkdirSync(path.join(root, 'agents', 'bot'), { recursive: true });
  fs.symlinkSync(ws, path.join(root, 'agents', 'bot', 'workspace'));
  agent = { id: 'bot', description: 'test', type: 'app-agent', container: 'demo-agent', isolateMemory: true, workspace: path.join(root, 'agents', 'bot', 'workspace'), env: '', claude: { model: 'm', dangerouslySkipPermissions: false, extraFlags: [] } };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const byTarget = (mounts: ReturnType<typeof sandboxMounts>) => Object.fromEntries(mounts.map(m => [m.target, m]));

describe('sandboxMounts', () => {
  it('mounts the shared workspace files read-only and leaves out every per-user or state entry', () => {
    const mounts = byTarget(sandboxMounts(agent, A, []));
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'SOUL.md', 'skills', 'tools']) expect(mounts[`/workspace/${name}`]).toMatchObject({ readonly: true });
    expect(mounts['/workspace/.claude/skills']).toMatchObject({ readonly: true });
    for (const name of ['MEMORY.md', 'USER.md', 'memory', 'SKILLS_LEARNED.md', 'kb.sqlite', 'kb.sqlite-wal', '.telegram-state', '.sessions', '.claude/agent-memory', 'host-etc', 'chats', 'notes-about-alice.md'])
      expect(mounts[`/workspace/${name}`]).toBeUndefined();
  });

  it("gives the conversation its own chats/ directory as the only writable workspace path", () => {
    const mounts = sandboxMounts(agent, A, []);
    const writable = mounts.filter(m => !m.readonly && m.target.startsWith('/workspace'));
    expect(writable).toEqual([{ source: path.join(ws, 'chats', chatMemoryDirName('telegram', '111')), target: `/workspace/chats/${chatMemoryDirName('telegram', '111')}`, readonly: false }]);
    expect(mounts.some(m => m.source.includes(chatMemoryDirName('telegram', '222')))).toBe(false);
  });

  it('gives it its own media directory and HOME, outside the workspace', () => {
    const mounts = byTarget(sandboxMounts(agent, A, []));
    expect(mounts[path.join(root, 'agents', 'bot', 'media', 'telegram-111')]).toMatchObject({ readonly: false });
    expect(mounts[os.homedir()]).toEqual({ source: path.join(root, 'agents', 'bot', 'sandbox-homes', chatMemoryDirName('telegram', '111')), target: os.homedir(), readonly: false });
    expect(mounts['/workspace/.orch']).toMatchObject({ readonly: true });
  });

  it('keeps only read-only runtime mounts of the app container', () => {
    const mounts = sandboxMounts(agent, A, [
      { source: '/usr/local/bin/claude', target: '/usr/local/bin/claude', readonly: true },
      { source: ws, target: '/workspace', readonly: true },
      { source: '/host/media', target: '/host/media', readonly: false },
    ]);
    expect(mounts.filter(m => m.target === '/workspace' || m.target === '/host/media')).toEqual([]);
    expect(mounts[0]).toEqual({ source: '/usr/local/bin/claude', target: '/usr/local/bin/claude', readonly: true });
  });

  it('leaves out an entry the --mount syntax cannot carry instead of refusing the sandbox', () => {
    expect(sandboxMounts(agent, A, []).some(m => m.source.includes('odd,name'))).toBe(false);
  });

  it('refuses a symlinked chats/ directory, which Docker would follow on the host', () => {
    fs.rmSync(path.join(ws, 'chats'), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(ws, 'chats'));
    expect(() => sandboxMounts(agent, A, [])).toThrow('SANDBOX_PATH_DENIED');
  });
});

describe('sandboxContainerName', () => {
  it('is one container per conversation, and per session for API chats', () => {
    expect(sandboxContainerName(agent, A)).toBe(sandboxContainerName(agent, { ...A }));
    expect(sandboxContainerName(agent, A)).not.toBe(sandboxContainerName(agent, B));
    expect(sandboxContainerName(agent, A)).not.toBe(sandboxContainerName(agent, { source: 'line', chatId: '111' }));
    expect(sandboxContainerName(agent, { source: 'api', chatId: 'c', sessionId: 's1' })).not.toBe(sandboxContainerName(agent, { source: 'api', chatId: 'c', sessionId: 's2' }));
    expect(() => sandboxContainerName(agent, { source: 'api', chatId: 'c' })).toThrow();
    expect(sandboxContainerName(agent, A)).toMatch(/^demo-agent-c-[0-9a-f]{20}$/);
  });

  it('applies only to isolated app agents', () => {
    expect(usesConversationSandbox(agent)).toBe(true);
    expect(usesConversationSandbox({ ...agent, isolateMemory: undefined })).toBe(false);
    expect(usesConversationSandbox({ ...agent, type: undefined })).toBe(false);
  });
});

it('shows only the persona among root files, and no per-user or state directory', () => {
  for (const name of ['MEMORY.md', 'USER.md', '.env', 'kb.sqlite', 'app.db', 'SKILLS_LEARNED.md', 'project_notes.md']) expect(workspaceEntryVisible(name, 'file')).toBe(false);
  for (const name of ['chats', 'memory', 'media', '.sessions', '.claude']) expect(workspaceEntryVisible(name, 'dir')).toBe(false);
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md']) expect(workspaceEntryVisible(name, 'file')).toBe(true);
  for (const name of ['skills', 'tools']) expect(workspaceEntryVisible(name, 'dir')).toBe(true);
});

describe('sandboxCreateArgs', () => {
  const base = {
    Name: '/demo-agent', Image: 'sha256:abc',
    Config: { User: '1000:1000', Env: ['APP_TOKEN=s3cret', 'PATH=/usr/bin'], Cmd: ['sh', '-c', 'exec sleep infinity'], Entrypoint: null, Labels: {} },
    HostConfig: { Memory: 268435456 }, NetworkSettings: { Networks: { demo_default: {} } },
  };

  it('drops every capability, forbids privilege gain and never puts env values on the argv', () => {
    const args = sandboxCreateArgs('demo-agent-c-1', base, sandboxMounts(agent, A, []), 'spec', {}, '/private/env');
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'demo_default', '--user', '1000:1000', '--env-file', '/private/env']));
    expect(args.join(' ')).not.toContain('s3cret');
    expect(args).toContain(`${SANDBOX_LABEL}=1`);
    expect(args.slice(-4)).toEqual(['sha256:abc', 'sh', '-c', 'exec sleep infinity']);
    expect(args.some(a => /target=\/workspace(,|$)/.test(a))).toBe(false);
  });
});

describe('validateContainerInspection, sandbox', () => {
  const inspection = (mounts: Array<{ Source: string; Destination: string; RW: boolean }>) => ({
    State: { Running: true },
    Config: { Labels: { [SANDBOX_LABEL]: '1' } },
    HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'demo_default' },
    Mounts: mounts.map(m => ({ Type: 'bind', ...m })),
  });
  const generated = () => sandboxMounts(agent, A, []).map(m => ({ Source: m.source, Destination: m.target, RW: !m.readonly }));
  const homeOf = (conversation: typeof A) => ({ Source: path.join(root, 'agents', 'bot', 'sandbox-homes', chatMemoryDirName(conversation.source, conversation.chatId)), Destination: os.homedir(), RW: true });

  it('accepts the mounts the gateway creates', async () => {
    await expect(validateContainerInspection(agent, inspection(generated()))).resolves.toBeUndefined();
  });

  it.each([
    ['the whole workspace', (ms: any[]) => [...ms, { Source: ws, Destination: '/workspace', RW: true }]],
    ["another conversation's directory", (ms: any[]) => [...ms, { Source: path.join(ws, 'chats', chatMemoryDirName('telegram', '222')), Destination: `/workspace/chats/${chatMemoryDirName('telegram', '222')}`, RW: true }]],
    ['a writable persona file', (ms: any[]) => ms.map(m => m.Destination === '/workspace/AGENTS.md' ? { ...m, RW: true } : m)],
    ['the root memory file', (ms: any[]) => [...ms, { Source: path.join(ws, 'MEMORY.md'), Destination: '/workspace/MEMORY.md', RW: false }]],
    ["another conversation's HOME", (ms: any[]) => { fs.mkdirSync(homeOf(B).Source, { recursive: true }); return [...ms.filter(m => m.Destination !== os.homedir()), homeOf(B)]; }],
    ['a root note file', (ms: any[]) => [...ms, { Source: path.join(ws, 'notes-about-alice.md'), Destination: '/workspace/notes-about-alice.md', RW: false }]],
    ['the shared media root', (ms: any[]) => [...ms, { Source: path.join(root, 'agents', 'bot', 'media'), Destination: path.join(root, 'agents', 'bot', 'media'), RW: true }]],
  ])('refuses %s', async (_name, change) => {
    fs.mkdirSync(path.join(root, 'agents', 'bot', 'media'), { recursive: true });
    await expect(validateContainerInspection(agent, inspection(change(generated())))).rejects.toMatchObject({ code: 'CONTAINER_HOST_MOUNT_DENIED' });
  });
});
