import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { buildNativeInvocation, discoverCodexSession, extractNativeSessionId, nativeEnvironment } from '../../../src/safemode/native';

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
const exec = execFileSync as jest.Mock;
const id = '11111111-2222-4333-8444-555555555555';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'safemode-native-test-')); exec.mockReturnValue('[]'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); jest.clearAllMocks(); });

it('isolates provider credentials from gateway, GitHub and shell startup injection', () => {
  const env = nativeEnvironment('claude', {
    HOME: '/home/operator', PATH: '/bin', ANTHROPIC_API_KEY: 'provider', OPENAI_API_KEY: 'other-provider',
    GH_TOKEN: 'github', GATEWAY_API_TOKEN: 'gateway', NODE_OPTIONS: '--require injected', BASH_ENV: '/injected',
    CLAUDECODE: '1', CODEX_THREAD_ID: 'parent',
  });
  expect(env).toEqual({ HOME: '/home/operator', PATH: '/bin', ANTHROPIC_API_KEY: 'provider' });
});

it('Claude starts a real interactive session with explicit identity and native model default', () => {
  const inv = buildNativeInvocation({ cli: 'claude', mode: 'interactive', cwd: root, context: 'diagnose', prompt: '--help', model: 'inherit', nativeSessionId: id });
  expect(inv.args).toContain('--session-id');
  expect(inv.args).not.toContain('--print');
  expect(inv.args).not.toContain('--model');
  expect(inv.args.slice(-2)).toEqual(['--', 'diagnose\n\n--help']);
});

it('Claude takeover resumes the identical conversation and removes writing/command tools', () => {
  const inv = buildNativeInvocation({ cli: 'claude', mode: 'headless', cwd: root, nativeSessionId: id, resume: true, context: 'updated runtime evidence', prompt: 'continue', model: 'sonnet' });
  expect(inv.args).toEqual(expect.arrayContaining(['--resume', id, '--tools', 'Read,Glob,Grep', '--restricted', '--safe-mode', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--model', 'sonnet']));
  expect(inv.args).not.toContain('--session-id');
  expect(inv.args).not.toContain('--fork-session');
  expect(inv.args.at(-1)).toBe('updated runtime evidence\n\ncontinue');
});

it('Codex explicitly disables configured MCP servers instead of trusting an empty merged table', () => {
  exec.mockReturnValue(JSON.stringify([{ name: 'shell' }, { name: 'quoted.server' }]));
  const inv = buildNativeInvocation({ cli: 'codex', mode: 'headless', cwd: root, nativeSessionId: id, resume: true, prompt: 'continue' });
  expect(inv.args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', 'notify=[]', 'features.hooks=false', 'features.plugins=false', 'mcp_servers."shell".enabled=false', 'mcp_servers."quoted.server".enabled=false', '--ignore-rules', 'resume', id]));
  expect(inv.args).not.toContain('--last');
  expect(inv.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(inv.args.slice(-2)).toEqual(['--', 'continue']);
});

it('fails closed if native MCP inspection is unavailable', () => {
  exec.mockImplementation(() => { throw new Error('bad output with credentials'); });
  expect(() => buildNativeInvocation({ cli: 'codex', mode: 'headless', cwd: root })).toThrow('Cannot inspect Codex MCP configuration safely');
});

it('requires an exact UUID for resume and accepts IDs only from authoritative init events', () => {
  expect(() => buildNativeInvocation({ cli: 'claude', mode: 'headless', cwd: root, resume: true })).toThrow('required');
  expect(() => buildNativeInvocation({ cli: 'codex', mode: 'interactive', cwd: root, nativeSessionId: '--last' })).toThrow('Invalid');
  expect(extractNativeSessionId('codex', JSON.stringify({ type: 'thread.started', thread_id: id }))).toBe(id);
  expect(extractNativeSessionId('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: id }))).toBe(id);
  expect(extractNativeSessionId('codex', JSON.stringify({ type: 'item.completed', thread_id: id }))).toBeUndefined();
  expect(extractNativeSessionId('claude', 'partial JSON')).toBeUndefined();
});

function rollout(name: string, meta: object) {
  const dir = path.join(root, 'sessions', '2026', '09', '20'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id, timestamp: '2026-09-20T12:00:01Z', cwd: '/dedicated', source: 'cli', ...meta } }) + '\nprivate conversation data');
}

it('discovers the native interactive session by dedicated cwd and launch time, excluding child and previous sessions', () => {
  rollout('old', { timestamp: '2026-09-20T11:59:00Z' });
  rollout('other-cwd', { cwd: '/someone-else' });
  rollout('child', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', source: { subagent: {} } });
  rollout('current', {});
  expect(discoverCodexSession({ cwd: '/dedicated', startedAt: '2026-09-20T12:00:00Z', codexHome: root })).toBe(id);
});

it('refuses ambiguous native sessions instead of silently resuming a different conversation', () => {
  rollout('one', {}); rollout('two', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  expect(() => discoverCodexSession({ cwd: '/dedicated', startedAt: '2026-09-20T12:00:00Z', codexHome: root })).toThrow('Multiple native Codex sessions');
});

it('preserves the native Claude model when restricted mode excludes user customizations', () => {
  const config = path.join(root, 'claude'); fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ model: 'native-model', env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-auth', ANTHROPIC_BASE_URL: 'https://provider.example', NODE_OPTIONS: 'injected' }, hooks: { unsafe: true } }));
  const inv = buildNativeInvocation({ cli: 'claude', mode: 'headless', cwd: root, model: 'inherit', env: { CLAUDE_CONFIG_DIR: config } });
  expect(inv.args).toEqual(expect.arrayContaining(['--model', 'native-model', '--restricted']));
  expect(inv.args.join(' ')).not.toContain('unsafe');
  expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-auth');
  expect(inv.env.NODE_OPTIONS).toBeUndefined();
});


it('keeps deliberate interactive params separate from restricted defaults', () => {
  const inv = buildNativeInvocation({ cli: 'codex', mode: 'interactive', cwd: root, nativeArgs: ['--model', 'gpt-test'] });
  expect(inv.args).not.toContain('notify=[]');
  const restricted = buildNativeInvocation({ cli: 'codex', mode: 'interactive', cwd: root });
  expect(restricted.args).toContain('notify=[]');
});
