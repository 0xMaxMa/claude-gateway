/**
 * E2E test for the Telegram plugin process.
 *
 * Spawns the real server.ts via `bun`, intercepts Telegram Bot API calls with a
 * local HTTP mock server, and speaks MCP over the process's stdio. Verifies:
 *
 *   1. MCP handshake succeeds (plugin boots)
 *   2. tools/list returns expected tools
 *   3. Inbound message → sendChatAction('typing') → MCP channel notification
 *   4. reply tool → sendMessage on Telegram API
 *   5. reply to non-allowlisted chat → security error (no sendMessage call)
 *
 * Requires `bun` on PATH. The plugin uses TELEGRAM_API_ROOT to redirect API
 * calls to our mock instead of api.telegram.org.
 */

import { spawn, ChildProcess } from 'child_process'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as net from 'net'

const RECEIVER_PATH = path.resolve(__dirname, '../../mcp/gateway/tools/telegram/receiver-server.ts')
const BOT_TOKEN = 'test_token_e2e'
const USER_ID = '111222333'

// ── helpers ────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

type MockCall = { method: string; body: Record<string, unknown>; ts: number }

function startMockTelegramServer(port: number) {
  const calls: MockCall[] = []
  const pendingUpdates: object[] = []
  const pollWaiters: Array<() => void> = []
  let updateIdCounter = 0

  function flushWaiters() {
    // Wake all long-poll holders so they can pick up pending updates
    const ws = pollWaiters.splice(0)
    for (const w of ws) w()
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop()?.split('?')[0] ?? ''
      let body: Record<string, unknown> = {}
      try { body = raw ? JSON.parse(raw) : {} } catch {}
      const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      qs.forEach((v, k) => { body[k] = v })

      calls.push({ method, body, ts: Date.now() })

      const ok = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }

      switch (method) {
        case 'getMe':
          ok({ id: 99999, is_bot: true, username: 'testbot', first_name: 'TestBot' })
          break

        case 'deleteWebhook':
          ok(true)
          break

        case 'getUpdates': {
          // True long-poll: hold until an update arrives OR 400 ms elapses.
          const deliver = () => {
            if (pendingUpdates.length > 0) {
              const updates = pendingUpdates.splice(0).map(u => ({
                update_id: ++updateIdCounter,
                ...(u as object),
              }))
              ok(updates)
            } else {
              ok([])
            }
          }
          if (pendingUpdates.length > 0) {
            deliver()
          } else {
            let done = false
            const timer = setTimeout(() => {
              if (!done) { done = true; deliver() }
            }, 400)
            pollWaiters.push(() => {
              if (!done) { done = true; clearTimeout(timer); deliver() }
            })
          }
          break
        }

        case 'sendChatAction':
          ok(true)
          break

        case 'sendMessage':
          ok({
            message_id: 500,
            chat: { id: Number(body['chat_id']), type: 'private' },
            text: body['text'],
            date: Math.floor(Date.now() / 1000),
          })
          break

        case 'setMessageReaction':
          ok(true)
          break

        case 'setMyCommands':
          ok(true)
          break

        default:
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true, result: true }))
      }
    })
  })

  server.listen(port, '127.0.0.1')

  return {
    calls,
    queueUpdate(update: object) {
      pendingUpdates.push(update)
      flushWaiters()
    },
    /** Poll until a call to `method` appears at or after `afterTs` (ms). */
    async waitForCall(method: string, afterTs: number, timeoutMs = 8000): Promise<MockCall> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = calls.find(c => c.method === method && c.ts >= afterTs)
        if (found) return found
        await sleep(50)
      }
      const seen = [...new Set(calls.map(c => c.method))].join(', ')
      throw new Error(`Timed out waiting for Telegram API call '${method}'. Seen: ${seen}`)
    },
    close: () => new Promise<void>(res => server.close(() => res())),
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── MCP stdio helpers ───────────────────────────────────────────────────────

function writeMcp(proc: ChildProcess, msg: object) {
  proc.stdin!.write(JSON.stringify(msg) + '\n')
}

function makeMcpReader(proc: ChildProcess) {
  const messages: object[] = []
  const listeners: Array<(m: object) => void> = []
  let buf = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        messages.push(msg)
        for (const l of [...listeners]) l(msg)
      } catch {}
    }
  })

  return {
    messages,
    wait<T = object>(predicate: (m: object) => boolean, timeoutMs = 8000): Promise<T> {
      const found = messages.find(predicate)
      if (found) return Promise.resolve(found as T)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.splice(listeners.indexOf(listener), 1)
          reject(new Error(`waitForMcp timed out (${timeoutMs}ms). Got ${messages.length} messages.`))
        }, timeoutMs)
        const listener = (msg: object) => {
          if (predicate(msg)) {
            clearTimeout(timer)
            listeners.splice(listeners.indexOf(listener), 1)
            resolve(msg as T)
          }
        }
        listeners.push(listener)
      })
    },
  }
}

// ── test suite ──────────────────────────────────────────────────────────────

describe('Telegram plugin E2E (process + mock Telegram API)', () => {
  let tmpDir: string
  let mock: ReturnType<typeof startMockTelegramServer>
  let proc: ChildProcess
  let mcp: ReturnType<typeof makeMcpReader>
  let idSeq = 10

  function nextId() { return ++idSeq }

  beforeAll(async () => {
    // Check bun is available
    const { execSync } = await import('child_process')
    try {
      execSync('bun --version', { stdio: 'ignore' })
    } catch {
      // eslint-disable-next-line no-console
      console.warn('bun not found — skipping Telegram plugin process tests')
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-proc-e2e-'))

    // Pre-pair USER_ID so inbound messages are delivered (not sent to pairing flow)
    const access = {
      dmPolicy: 'allowlist',
      allowFrom: [USER_ID],
      groups: {},
      pending: {},
    }
    fs.writeFileSync(path.join(tmpDir, 'access.json'), JSON.stringify(access, null, 2))

    const port = await getFreePort()
    mock = startMockTelegramServer(port)

    proc = spawn('bun', [RECEIVER_PATH], {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_STATE_DIR: tmpDir,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stderrLines: string[] = []
    proc.stderr!.on('data', (c: Buffer) => {
      stderrLines.push(c.toString().trim())
    })
    proc.on('error', err => {
      stderrLines.push(`proc error: ${err.message}`)
    })

    mcp = makeMcpReader(proc)

    // MCP handshake
    const initResponse = mcp.wait<any>(
      m => (m as any).id === 1 && (m as any).result?.serverInfo !== undefined,
      10000,
    )
    writeMcp(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'jest-e2e', version: '1.0.0' },
      },
    })
    await initResponse
    writeMcp(proc, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

    // Wait for bot to start polling (getMe is a reliable signal)
    await mock.waitForCall('getMe', 0, 10000)
  }, 30000)

  afterAll(async () => {
    try { proc?.kill('SIGTERM') } catch {}
    await mock.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── test 1 ──────────────────────────────────────────────────────────────

  test('tools/list returns reply, react, download_attachment, edit_message', async () => {
    const id = nextId()
    const res = mcp.wait<any>(m => (m as any).id === id && (m as any).result?.tools, 5000)
    writeMcp(proc, { jsonrpc: '2.0', id, method: 'tools/list', params: {} })
    const result = await res
    const names: string[] = result.result.tools.map((t: any) => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('react')
    expect(names).toContain('download_attachment')
    expect(names).toContain('edit_message')
  }, 10000)

  // ── test 2 ──────────────────────────────────────────────────────────────

  test('inbound message from paired user → typing indicator + MCP channel notification', async () => {
    const t0 = Date.now()
    const now = Math.floor(t0 / 1000)

    // Queue an update so Grammy's next getUpdates poll delivers it
    mock.queueUpdate({
      message: {
        message_id: 42,
        from: { id: Number(USER_ID), username: 'tester', is_bot: false, first_name: 'Tester' },
        chat: { id: Number(USER_ID), type: 'private' },
        date: now,
        text: 'hello plugin',
      },
    })

    // Typing indicator must arrive on Telegram API
    const typingCall = await mock.waitForCall('sendChatAction', t0, 10000)
    expect(typingCall.body['action']).toBe('typing')
    expect(String(typingCall.body['chat_id'])).toBe(USER_ID)

    // MCP notification must arrive on stdout
    const notification = await mcp.wait<any>(
      m => (m as any).method === 'notifications/claude/channel' &&
           (m as any).params?.meta?.chat_id === USER_ID,
      10000,
    )
    expect(notification.params.content).toBe('hello plugin')
    expect(notification.params.meta.user).toBe('tester')
    expect(notification.params.meta.message_id).toBe('42')
  }, 15000)

  // ── test 3 ──────────────────────────────────────────────────────────────

  test('reply tool → sendMessage sent to Telegram API', async () => {
    const t0 = Date.now()
    const id = nextId()

    const res = mcp.wait<any>(m => (m as any).id === id && (m as any).result, 8000)
    writeMcp(proc, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'reply',
        arguments: { chat_id: USER_ID, text: 'hello from jest test' },
      },
    })

    const result = await res
    expect(result.result.isError).toBeFalsy()
    expect(result.result.content[0].text).toMatch(/sent/)

    const sendCall = await mock.waitForCall('sendMessage', t0, 5000)
    expect(String(sendCall.body['chat_id'])).toBe(USER_ID)
    expect(sendCall.body['text']).toBe('hello from jest test')
  }, 15000)

  // ── test 4 ──────────────────────────────────────────────────────────────

  test('reply to non-allowlisted chat_id → isError=true, sendMessage NOT called', async () => {
    const t0 = Date.now()
    const id = nextId()

    const res = mcp.wait<any>(m => (m as any).id === id && (m as any).result, 5000)
    writeMcp(proc, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'reply',
        arguments: { chat_id: '999888777', text: 'should be blocked by security' },
      },
    })

    const result = await res
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toMatch(/not allowlisted/)

    // Give a moment to ensure no stray sendMessage was fired
    await sleep(300)
    const stray = mock.calls.find(c => c.method === 'sendMessage' && c.ts >= t0 &&
      String(c.body['chat_id']) === '999888777')
    expect(stray).toBeUndefined()
  }, 10000)

  // ── test 5 ──────────────────────────────────────────────────────────────

  test('inbound message from unknown (non-paired) user → drop (no notification, no typing)', async () => {
    const t0 = Date.now()
    const unknownId = 888777666

    mock.queueUpdate({
      message: {
        message_id: 99,
        from: { id: unknownId, username: 'stranger', is_bot: false, first_name: 'Stranger' },
        chat: { id: unknownId, type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'let me in',
      },
    })

    // Allow time for Grammy to pick up the update
    await sleep(1500)

    // No typing action for this user
    const typingForStranger = mock.calls.find(
      c => c.method === 'sendChatAction' && c.ts >= t0 &&
           String(c.body['chat_id']) === String(unknownId)
    )
    expect(typingForStranger).toBeUndefined()

    // No channel notification for this user
    const notifForStranger = mcp.messages.find(
      (m: any) => m.method === 'notifications/claude/channel' &&
                  m.params?.meta?.chat_id === String(unknownId)
    )
    expect(notifForStranger).toBeUndefined()
  }, 10000)
})
