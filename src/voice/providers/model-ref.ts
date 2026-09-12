/** BYOK catalog IDs follow the upstream model catalog's provider/model namespace.
 * Keep legacy bare IDs working on their explicitly selected provider route.
 * A future managed-pool route must be explicit; missing BYOK credentials never
 * fall back to a different payer. The native API always receives a bare model.
 */
export function nativeVoiceModel(provider: string, model: string): string {
  const namespace = provider === 'upstream' ? 'elevenlabs' : provider.replace(/^upstream:/, '');
  if (!model.includes('/')) return model;
  if (!model.startsWith(namespace + '/') || model.slice(namespace.length + 1).includes('/')) throw Error('VOICE_MODEL_PROVIDER_MISMATCH');
  return model.slice(namespace.length + 1);
}
