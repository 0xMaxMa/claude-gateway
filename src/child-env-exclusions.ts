/** Internal, names-only exclusion policy inherited by gateway-created CLI descendants. */
export const CHILD_ENV_EXCLUSIONS = 'GATEWAY_CHILD_ENV_EXCLUSIONS';
export function childEnvExclusions(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[CHILD_ENV_EXCLUSIONS];
  if (!raw) return new Set();
  let names: unknown;
  try { names = JSON.parse(raw); } catch { throw new Error('Invalid child environment exclusion policy'); }
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('Invalid child environment exclusion policy');
  }
  return new Set(names as string[]);
}
