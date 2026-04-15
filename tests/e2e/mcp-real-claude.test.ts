/**
 * E2E test with REAL Claude binary + REAL Telegram plugin (mock Telegram API)
 *
 * Tests the actual MCP pipeline as it runs in production:
 *   real claude --mcp-config --channels server:telegram
 *     └─ spawns: bun mcp/gateway/tools/telegram/receiver-server.ts
 *           └─ Grammy polls mock Telegram API
 *                └─ message queued → plugin sends notifications/claude/channel
 *                      └─ Claude receives, calls reply tool
 *                            └─ plugin calls mock sendMessage
 *
 * Verifications (in order of pipeline depth):
 *   A. Plugin boots: getMe called on mock Telegram API  (MCP server started)
 *   B. Channel message: typing indicator after update   (MCP notification sent)
 *   C. Claude replies: sendMessage called               (Claude called reply tool)
 *
 * Run: npm test -- --testPathPattern="mcp-real-claude" --verbose
 */

import { spawn, ChildProcess } from 'child_process'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as net from 'net'

const RECEIVER_PATH = path.resolve(__dirname, '../../mcp/gateway/tools/telegram/receiver-server.ts')
const BOT_TOKEN = 'real_e2e_test_token'
const USER_ID = '555444333'
const TEST_TIMEOUT_MS = 90_000

// ── mock Telegram server ──────────────────────────────────────────────────────

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
  let updateIdCounter = 500

  function flushWaiters() {
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
          ok({ id: 22222, is_bot: true, username: 'real_e2e_bot', first_name: 'RealE2E' })
          break
        case 'deleteWebhook':
          ok(true)
          break
        case 'getUpdates': {
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
            }, 500)
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
            message_id: 300,
            chat: { id: Number(body['chat_id']), type: 'private' },
            text: body['text'],
            date: Math.floor(Date.now() / 1000),
          })
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
    async waitForCall(method: string, afterTs: number, timeoutMs = 15000): Promise<MockCall> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = calls.find(c => c.method === method && c.ts >= afterTs)
        if (found) return found
        await sleep(100)
      }
      const seen = [...new Set(calls.map(c => c.method))].join(', ')
      throw new Error(`Timed out waiting for Telegram API call '${method}' (${timeoutMs}ms). Seen: ${seen}`)
    },
    close: () => new Promise<void>(res => server.close(() => res())),
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── callback bridge server (mirrors agent-runner's startCallbackServer) ───────

function startCallbackServer(
  onChannel: (params: { content?: string; meta?: Record<string, string> }) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        res.writeHead(200)
        res.end('ok')
        try { onChannel(JSON.parse(raw)) } catch {}
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        port: addr.port,
        close: () => new Promise<void>(res => server.close(() => res())),
      })
    })
    server.on('error', reject)
  })
}

// ── shared state ──────────────────────────────────────────────────────────────

let tmpDir: string
let mock: ReturnType<typeof startMockTelegramServer>
let callbackClose: () => Promise<void>
let claudeProc: ChildProcess
let stdoutLines: string[]
let stderrLines: string[]
let port: number

// ── suite setup ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  port = await getFreePort()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-claude-mcp-'))

  // Pre-approve test user (skip pairing flow)
  const access = {
    dmPolicy: 'allowlist',
    allowFrom: [USER_ID],
    groups: {},
    pending: {},
  }
  fs.mkdirSync(path.join(tmpDir, '.telegram-state'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(tmpDir, '.telegram-state', 'access.json'),
    JSON.stringify(access, null, 2),
  )

  // Start callback bridge: injects channel notifications as stream-json turns.
  // This is the same mechanism as agent-runner's startCallbackServer().
  const cb = await startCallbackServer(params => {
    if (!claudeProc?.stdin?.writable) return
    const meta = params.meta ?? {}
    const channelXml =
      `<channel source="telegram" chat_id="${meta['chat_id'] ?? ''}" ` +
      `message_id="${meta['message_id'] ?? ''}" user="${meta['user'] ?? ''}" ` +
      `ts="${meta['ts'] ?? new Date().toISOString()}">` +
      `${params.content ?? ''}` +
      `</channel>`
    const turn = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: channelXml }] },
    })
    process.stderr.write(`[callback bridge] injecting turn: ${channelXml}\n`)
    claudeProc.stdin!.write(turn + '\n')
  })
  callbackClose = cb.close

  // MCP config: telegram plugin with env injection + callback bridge URL
  const mcpConfig = {
    mcpServers: {
      telegram: {
        command: 'bun',
        args: [RECEIVER_PATH],
        env: {
          TELEGRAM_BOT_TOKEN: BOT_TOKEN,
          TELEGRAM_STATE_DIR: path.join(tmpDir, '.telegram-state'),
          TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
          CLAUDE_CHANNEL_CALLBACK: `http://127.0.0.1:${cb.port}/channel`,
        },
      },
    },
  }
  const mcpConfigPath = path.join(tmpDir, '.mcp-config.json')
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

  mock = startMockTelegramServer(port)

  stdoutLines = []
  stderrLines = []

  // Spawn real Claude with stream-json input so we can inject multi-turn
  // messages while stdin stays open, and --channels to keep it alive for
  // incoming MCP notifications/claude/channel events from the plugin.
  claudeProc = spawn('claude', [
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--model', 'claude-haiku-4-5-20251001',
    '--dangerously-skip-permissions',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--print',
    '--verbose',
    '--channels', 'server:telegram',
  ], {
    cwd: tmpDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  claudeProc.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    for (const line of text.split('\n').filter(l => l.trim())) {
      stdoutLines.push(line)
      process.stderr.write(`[claude stdout] ${line}\n`)
    }
  })

  claudeProc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    for (const line of text.split('\n').filter(l => l.trim())) {
      stderrLines.push(line)
      process.stderr.write(`[claude stderr] ${line}\n`)
    }
  })

  claudeProc.on('error', err => {
    stderrLines.push(`[spawn error] ${err.message}`)
    process.stderr.write(`[claude spawn error] ${err.message}\n`)
  })

  claudeProc.on('exit', (code, signal) => {
    process.stderr.write(`[claude exit] code=${code} signal=${signal}\n`)
  })

  // Send initial prompt as a stream-json user turn.  stdin stays open so
  // the plugin's notifications/claude/channel events can trigger new turns.
  const initialTurn = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: 'You are a helpful Telegram assistant. ' +
              'Channels mode is active. Wait for incoming Telegram messages ' +
              'and reply to them using the reply tool provided by the telegram MCP plugin.',
      }],
    },
  })
  claudeProc.stdin!.write(initialTurn + '\n')

  // Wait for the MCP plugin to start (getMe = Grammy connected)
  // This confirms: claude started + spawned the MCP server + MCP handshake done
  await mock.waitForCall('getMe', 0, 30000)
}, TEST_TIMEOUT_MS)

afterAll(async () => {
  try { claudeProc?.kill('SIGTERM') } catch {}
  await mock?.close()
  await callbackClose?.()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Real Claude + MCP plugin pipeline', () => {

  test('A — Plugin boots: MCP server started, Grammy connected to mock Telegram API', async () => {
    // getMe already waited for in beforeAll — confirm it happened
    const getMe = mock.calls.find(c => c.method === 'getMe')
    expect(getMe).toBeDefined()
    console.log('✓ Plugin started, bot username: real_e2e_bot')
  })

  test('B — Channel message: typing indicator sent after Telegram update arrives', async () => {
    const t0 = Date.now()

    mock.queueUpdate({
      message: {
        message_id: 5001,
        from: {
          id: Number(USER_ID),
          username: 'real_e2e_user',
          is_bot: false,
          first_name: 'RealUser',
        },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'Hello from E2E test!',
      },
    })

    // Plugin must send typing indicator (happens before MCP notification)
    // This confirms: Grammy received the update → plugin processed it → sendChatAction
    const typingCall = await mock.waitForCall('sendChatAction', t0, 10000)
    expect(typingCall.body['action']).toBe('typing')
    expect(String(typingCall.body['chat_id'])).toBe(USER_ID)
    console.log('✓ Typing indicator sent — plugin received update and sent MCP notification')
  }, 20000)

  test('C — Claude replies: sendMessage called after Claude processes channel notification', async () => {
    const t0 = Date.now()

    // Send a clear, simple message that Claude should reply to
    mock.queueUpdate({
      message: {
        message_id: 5002,
        from: {
          id: Number(USER_ID),
          username: 'real_e2e_user',
          is_bot: false,
          first_name: 'RealUser',
        },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'Reply with the exact text: MCP_WORKS',
      },
    })

    // Wait for Claude to call the reply tool → plugin calls sendMessage
    // Long timeout because LLM inference takes time
    const sendCall = await mock.waitForCall('sendMessage', t0, 60000)
    expect(String(sendCall.body['chat_id'])).toBe(USER_ID)
    console.log(`✓ Claude replied via MCP! message: "${sendCall.body['text']}"`)
    console.log(`  → Full pipeline confirmed: Telegram → MCP → Claude → reply tool → Telegram`)
  }, 75000)

  test('D — Diagnostics: log captured stdout/stderr', () => {
    console.log(`\nClaude stdout lines (${stdoutLines.length}):`)
    stdoutLines.slice(0, 20).forEach(l => console.log(`  ${l}`))

    console.log(`\nClaude stderr lines (${stderrLines.length}):`)
    stderrLines.slice(0, 20).forEach(l => console.log(`  ${l}`))

    console.log(`\nMock Telegram API calls (${mock.calls.length}):`)
    mock.calls.forEach(c => console.log(`  ${c.method}`))

    // This test always passes — it's for debugging when other tests fail
    expect(mock.calls.length).toBeGreaterThan(0)
  })
})
