import { CHILD_ENV_EXCLUSIONS, childEnvExclusions } from '../child-env-exclusions';
import { JevConfig, JevError } from './types';

/** Jev credentials must use their own variable, never a native CLI/control variable. */
export function isReservedJevCredentialEnv(name: string): boolean {
  return /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|TELEGRAM_|DISCORD_|SLACK_|LINE_|WHATSAPP_|AWS_|GOOGLE_|AZURE_)/.test(name)
    || (/^GATEWAY_/.test(name) && !/^GATEWAY_JEV_/.test(name))
    || /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|TERM|NODE_OPTIONS|BASH_ENV|ENV|ZDOTDIR|LD_PRELOAD|LD_LIBRARY_PATH|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(name);
}
// Retain observed references for the process lifetime so hot reload cannot turn an
// old credential into an ordinary inherited child variable. Values are never stored.
const privateNames = new Set(['TYPESAFE_API_KEY', 'JEV_API_KEY', 'JEV_TEXT_API_KEY']);
export function jevCredentialEnvNames(config?: JevConfig): string[] {
  if (config?.apiKeyEnv && isReservedJevCredentialEnv(config.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Jev apiKeyEnv must use a dedicated credential variable, not native CLI authentication or process controls.');
  if (config?.apiKeyEnv) privateNames.add(config.apiKeyEnv);
  const textKey = config?.browser?.textHelper?.apiKeyEnv;
  if(textKey){if(isReservedJevCredentialEnv(textKey))throw new JevError('INVALID_CONFIG','Browser text helper requires a dedicated credential variable.');privateNames.add(textKey);}
  for (const binding of config?.browser?.bindings ?? []) {
    if (binding.apiKeyEnv && isReservedJevCredentialEnv(binding.apiKeyEnv)) throw new JevError('INVALID_CONFIG', 'Browser credentials require a dedicated environment variable.');
    if (binding.apiKeyEnv) privateNames.add(binding.apiKeyEnv);
  }
  return [...privateNames];
}
/** Apply after overlays. Do not mutate the gateway environment or native CLI authentication. */
export function sanitizeJevChildEnv<T extends Record<string, string | undefined>>(environment: T, config?: JevConfig): T {
  const clean = { ...environment };
  for (const name of jevCredentialEnvNames(config)) delete clean[name];
  return clean;
}

/** Gateway CLI children also load dotenv; carry names so bootstrap cannot restore secrets. */
export function managedJevChildEnv(environment: NodeJS.ProcessEnv, config?: JevConfig): NodeJS.ProcessEnv {
  const names = new Set([...childEnvExclusions(environment), ...jevCredentialEnvNames(config)]);
  const clean = sanitizeJevChildEnv(environment, config);
  for (const name of names) delete clean[name];
  return { ...clean, [CHILD_ENV_EXCLUSIONS]: JSON.stringify([...names]) };
}
