export async function fetchModelMenuResponses(
  callbackUrl: string,
  chatId: string,
  request: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ modelData: { model?: string }; modelsData: { models?: unknown; configuredModels?: unknown; liveModels?: unknown } }> {
  const signal = AbortSignal.timeout(timeoutMs)
  const [modelRes, modelsRes] = await Promise.all([
    request(callbackUrl + '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get_model', chat_id: chatId }),
      signal,
    }),
    request(callbackUrl + '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get_models' }),
      signal,
    }),
  ])
  if (!modelRes.ok || !modelsRes.ok) throw new Error('model request failed')
  return {
    modelData: await modelRes.json() as { model?: string },
    modelsData: await modelsRes.json() as { models?: unknown; configuredModels?: unknown; liveModels?: unknown },
  }
}

export function sendModelMenuReply<T>(
  send: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  return send(AbortSignal.timeout(timeoutMs))
}
