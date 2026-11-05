import { fetchModelMenuResponses, sendModelMenuReply } from '../../../mcp/tools/telegram/model-menu-request'
import { Bot } from '../../../mcp/node_modules/grammy'

const update = (id: number, text: string) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: 123, type: 'private' as const, first_name: 'Test' },
    from: { id: 123, is_bot: false, first_name: 'Test' },
    text,
    entities: [{ offset: 0, length: text.length, type: 'bot_command' as const }],
  },
})

const mockBot = () => {
  const bot = new Bot('mock-token')
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } as typeof bot.botInfo
  return bot
}

const handleTwoUpdates = (bot: Bot) => (bot as unknown as { handleUpdates: (updates: unknown[]) => Promise<void> })
  .handleUpdates([update(1, '/models'), update(2, '/session')])

test('/models cannot hold the next Telegram update when get_models never responds', async () => {
  const seen: string[] = []
  const request = jest.fn((_url: string, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)).command as string
    if (command === 'get_model') {
      return Promise.resolve({ ok: true, json: async () => ({ model: 'test-model' }) } as Response)
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as unknown as typeof fetch

  const bot = mockBot()
  bot.command('models', async () => {
    try { await fetchModelMenuResponses('http://127.0.0.1:1', '123', request, 30) }
    catch { seen.push('models-error') }
  })
  bot.command('session', () => { seen.push('session') })
  const outcome = await Promise.race([
    handleTwoUpdates(bot).then(() => 'done'),
    new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 500)),
  ])
  expect(outcome).toBe('done')
  expect(seen).toEqual(['models-error', 'session'])
})

test('/models Telegram send timeout releases the next update', async () => {
  const seen: string[] = []
  const bot = mockBot()
  bot.api.config.use((_previous, method, _payload, signal) => {
    expect(method).toBe('sendMessage')
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  bot.command('models', async ctx => {
    try { await sendModelMenuReply(signal => ctx.reply('model menu', {}, signal as Parameters<typeof ctx.reply>[2]), 30) }
    catch { seen.push('send-error') }
  })
  bot.command('session', () => { seen.push('session') })
  const outcome = await Promise.race([
    handleTwoUpdates(bot).then(() => 'done'),
    new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 500)),
  ])
  expect(outcome).toBe('done')
  expect(seen).toEqual(['send-error', 'session'])
})

test('model menu deadline settles even if the transport ignores abort', async () => {
  let signal: AbortSignal | undefined
  await expect(sendModelMenuReply(received => {
    signal = received
    return new Promise<void>(() => {})
  }, 30)).rejects.toHaveProperty('name', 'TimeoutError')
  expect(signal?.aborted).toBe(true)
})
