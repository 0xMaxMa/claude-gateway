/** Canonical provider identity; retain the original ElevenLabs relay spelling as an alias. */
export function canonicalVoiceProvider(provider: string): string {
  return provider === 'upstream' ? 'upstream:elevenlabs' : provider;
}

/** BYOK catalog IDs follow the upstream model catalog's provider/model namespace.
 * Keep legacy bare IDs working on their explicitly selected provider route.
 * A future managed-pool route must be explicit; missing BYOK credentials never
 * fall back to a different payer. The native API always receives a bare model.
 */
export function nativeVoiceModel(provider: string, model: string): string {
  const managed = provider.startsWith('managed:');
  const namespace = canonicalVoiceProvider(provider).replace(/^(upstream|managed):/, '');
  if (managed && model.startsWith('getpod-voice/')) model = model.slice('getpod-voice/'.length);
  if (namespace === 'openrouter') {
    const native = model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(native)) throw Error('VOICE_MODEL_PROVIDER_MISMATCH');
    return native;
  }
  if (!model.includes('/')) return model;
  if (!model.startsWith(namespace + '/') || model.slice(namespace.length + 1).includes('/')) throw Error('VOICE_MODEL_PROVIDER_MISMATCH');
  return model.slice(namespace.length + 1);
}
