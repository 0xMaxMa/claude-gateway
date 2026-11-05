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

export async function sendModelMenuReply<T>(
  send: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const error = new Error('Telegram model menu request timed out')
      error.name = 'TimeoutError'
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([send(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
