import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { upstreamVoiceConnection } from '../../../src/voice/providers/upstream';

const keys = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
let original: NodeJS.ProcessEnv, dir: string;
beforeEach(() => {
  original = {...process.env}; dir = mkdtempSync(join(tmpdir(), 'upstream-settings-'));
  for (const key of keys) delete process.env[key];
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => {
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  rmSync(dir, {recursive: true, force: true});
});
const settings = (env: Record<string, unknown>) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({env}));

test.each(['paxalabs', 'gemini', 'elevenlabs'] as const)('cold start resolves %s through Claude settings without exported credentials', provider => {
  settings({ANTHROPIC_BASE_URL: 'https://provider.test', CLAUDE_CODE_OAUTH_TOKEN: 'settings-token'});
  expect(upstreamVoiceConnection(provider)).toEqual({base: new URL(`https://provider.test/v1/voice/${provider}/`), key: 'settings-token'});
  expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
});
test('settings identity wins as a group and rotation is observed without restart', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://old.test'; process.env.ANTHROPIC_AUTH_TOKEN = 'old-token';
  settings({ANTHROPIC_BASE_URL: 'https://new.test', CLAUDE_CODE_OAUTH_TOKEN: 'new-token'});
  expect(upstreamVoiceConnection().key).toBe('new-token');
  expect(upstreamVoiceConnection().base.host).toBe('new.test');
  settings({ANTHROPIC_BASE_URL: 'https://new.test', CLAUDE_CODE_OAUTH_TOKEN: 'rotated-token'});
  expect(upstreamVoiceConnection().key).toBe('rotated-token');
});
test.each(['', 'bad\ntoken', 42])('invalid settings credential never falls back to another environment identity (%p)', value => {
  process.env.ANTHROPIC_BASE_URL = 'https://provider.test'; process.env.ANTHROPIC_AUTH_TOKEN = 'other-account';
  settings({CLAUDE_CODE_OAUTH_TOKEN: value});
  expect(() => upstreamVoiceConnection()).toThrow('UPSTREAM_VOICE_CREDENTIALS_MISSING');
});
test('environment-only deployments remain supported', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://provider.test'; process.env.ANTHROPIC_API_KEY = 'env-key';
  expect(upstreamVoiceConnection().key).toBe('env-key');
});
