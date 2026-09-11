import { claudeSettingsEnv } from '../../config/claude-settings';
import { VoiceError } from '../types';
import { openProviderSocket, SocketFactory } from './socket';

/** Reuses the pod's existing provider credentials; never exposes upstream BYOK keys. */
export function upstreamVoiceConnection(provider: 'elevenlabs' | 'paxalabs' | 'gemini' = 'elevenlabs'): { base: URL; key: string } {
  // Claude Code applies settings.json over inherited environment. Resolve the
  // credential group together so a settings identity never uses another token.
  const settings = claudeSettingsEnv();
  const credentialKeys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
  const credentials = credentialKeys.some(key => key in settings) ? settings : process.env;
  const clean = (value: unknown): string => typeof value === 'string' && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
  const endpoint = 'ANTHROPIC_BASE_URL' in settings ? settings.ANTHROPIC_BASE_URL : process.env.ANTHROPIC_BASE_URL;
  let base: URL;
  try {
    base = new URL(clean(endpoint));
  } catch {
    throw new VoiceError('INVALID_UPSTREAM_VOICE_URL');
  }
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new VoiceError('INVALID_UPSTREAM_VOICE_URL');
  if (
    base.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  )
    throw new VoiceError('INVALID_UPSTREAM_VOICE_URL');
  base.pathname = `/v1/voice/${provider}/`;
  const key = credentialKeys.map(name => clean(credentials[name])).find(Boolean) ?? '';
  if (!key) throw new VoiceError('UPSTREAM_VOICE_CREDENTIALS_MISSING');
  return { base, key };
}
export const upstreamVoiceSocket: SocketFactory = async (
  upstream,
  _headers,
  signal,
) => {
  const { base, key } = upstreamVoiceConnection();
  const source = new URL(upstream);
  const url = new URL(source.pathname.replace(/^\/v1\//, ''), base);
  url.search = source.search;
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return openProviderSocket(
    url.toString(),
    { Authorization: `Bearer ${key}` },
    signal,
  );
};
