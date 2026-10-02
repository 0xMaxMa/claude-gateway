jest.mock('../../../src/config/claude-settings', () => ({ claudeSettingsEnv: jest.fn() }));
import { claudeSettingsEnv } from '../../../src/config/claude-settings';
import { resolveGatewayJevConnection } from '../../../src/orchestration/jev-gateway';
const settings = claudeSettingsEnv as jest.Mock;
const original = { ...process.env };
beforeEach(() => {
  settings.mockReturnValue({});
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'JEV_TEST_KEY']) delete process.env[key];
});
afterEach(() => { process.env = { ...original }; });
test('uses a complete settings identity before the inherited environment', async () => {
  settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_API_KEY: 'settings-key' });
  process.env.ANTHROPIC_BASE_URL = 'https://shell.example'; process.env.ANTHROPIC_API_KEY = 'shell-key';
  await expect(resolveGatewayJevConnection({ provider: 'upstream' })).resolves.toEqual({ baseUrl: 'https://settings.example', apiKey: 'settings-key' });
});
test.each([
  { ANTHROPIC_BASE_URL: 'https://settings.example' },
  { ANTHROPIC_API_KEY: 'settings-key' },
  { ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '' },
])('never combines incomplete settings with environment credentials or endpoint: %j', async incomplete => {
  settings.mockReturnValue(incomplete);
  process.env.ANTHROPIC_BASE_URL = 'https://shell.example'; process.env.ANTHROPIC_API_KEY = 'shell-key';
  await expect(resolveGatewayJevConnection({ provider: 'upstream' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
});
test('falls back to the complete environment identity when settings has no identity group', async () => {
  settings.mockReturnValue({ UNRELATED: 'true' });
  process.env.ANTHROPIC_BASE_URL = 'https://shell.example'; process.env.ANTHROPIC_AUTH_TOKEN = 'shell-key';
  await expect(resolveGatewayJevConnection({ provider: 'upstream' })).resolves.toEqual({ baseUrl: 'https://shell.example', apiKey: 'shell-key' });
});
test('explicit endpoint requires explicit key and vice versa', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://shell.example'; process.env.ANTHROPIC_API_KEY = 'shell-key'; process.env.JEV_TEST_KEY = 'explicit-key';
  await expect(resolveGatewayJevConnection({ provider: 'upstream', baseUrl: 'https://override.example' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  await expect(resolveGatewayJevConnection({ provider: 'upstream', apiKeyEnv: 'JEV_TEST_KEY' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  await expect(resolveGatewayJevConnection({ provider: 'upstream', baseUrl: 'https://override.example', apiKeyEnv: 'JEV_TEST_KEY' })).resolves.toEqual({ baseUrl: 'https://override.example', apiKey: 'explicit-key' });
});
test('rejects whitespace/control characters in inherited credentials without logging them', async () => {
  settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_API_KEY: 'secret\nheader' });
  await expect(resolveGatewayJevConnection({ provider: 'upstream' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
});
