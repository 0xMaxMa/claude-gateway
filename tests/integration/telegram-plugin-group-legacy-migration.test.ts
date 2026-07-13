/**
 * E2E regression test for the legacy per-group `allowFrom` migration fix.
 *
 * Spawns the real receiver-server.ts via `bun` (same harness as
 * telegram-plugin-process.test.ts) and intercepts Telegram Bot API calls with
 * a local HTTP mock server. No part of the fix under test is mocked or
 * duplicated — this exercises the actual migrateAccess()/gate() code that
 * ships, only the network boundary to Telegram is faked.
 *
 * Seeds a pre-split access.json (`groups: { [groupId]: { allowFrom } }`) —
 * the schema that shipped before the incoming-first pairing rework — and
 * verifies that on migration:
 *   1. a sender NOT in the legacy allowFrom list is dropped (no typing
 *      indicator, no MCP channel notification) even though the group itself
 *      is allowlisted — this is the exact regression a prior version of the
 *      migration would have silently opened up.
 *   2. a sender IN the legacy allowFrom list is still delivered.
 *   3. a group with no legacy restriction is unaffected (regression guard).
 *
 * Requires `bun` on PATH.
 */

import { spawn, ChildProcess } from 'child_process'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as net from 'net'

const RECEIVER_PATH = path.resolve(__dirname, '../../mcp/tools/telegram/receiver-server.ts')
const BOT_TOKEN = 'test_token_group_legacy'
const RESTRICTED_GROUP_ID = -1001111111
const ALLOWED_SENDER_ID = 111
const EXCLUDED_SENDER_ID = 222
const OPEN_GROUP_ID = -1002222222
const OPEN_GROUP_SENDER_ID = 333

// ── helpers (mirrors telegram-plugin-process.test.ts) ──────────────────────

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
            chat: { id: Number(body['chat_id']), type: 'group' },
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

function groupUpdate(opts: { msgId: number; senderId: number; groupId: number; text: string }) {
  return {
    message: {
      message_id: opts.msgId,
      from: { id: opts.senderId, username: `user${opts.senderId}`, is_bot: false, first_name: 'Tester' },
      chat: { id: opts.groupId, type: 'group', title: 'Test Group' },
      date: Math.floor(Date.now() / 1000),
      text: opts.text,
    },
  }
}

// ── test suite ──────────────────────────────────────────────────────────────

describe('Telegram legacy group allowFrom migration (real process + mock Telegram API)', () => {
  let tmpDir: string
  let mock: ReturnType<typeof startMockTelegramServer>
  let proc: ChildProcess
  let mcp: ReturnType<typeof makeMcpReader>

  beforeAll(async () => {
    const { execSync } = await import('child_process')
    try {
      execSync('bun --version', { stdio: 'ignore' })
    } catch {
      // eslint-disable-next-line no-console
      console.warn('bun not found — skipping Telegram legacy group migration test')
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-group-legacy-e2e-'))

    // Pre-split legacy schema: no groupAllowlist/legacyGroupAllowFrom fields at
    // all, just the old per-group `groups` map. This is exactly what a real
    // agent's access.json looked like before the incoming-first pairing
    // rework shipped. requireMention:false on both groups so this test
    // isolates the allowFrom restriction from the (separately unit-tested)
    // mention gate.
    const legacyAccess = {
      dmPolicy: 'disabled',
      groupPolicy: 'allowlist',
      requireMention: false,
      groups: {
        [String(RESTRICTED_GROUP_ID)]: { requireMention: false, allowFrom: [String(ALLOWED_SENDER_ID)] },
        [String(OPEN_GROUP_ID)]: { requireMention: false, allowFrom: [] },
      },
      pending: {},
    }
    fs.writeFileSync(path.join(tmpDir, 'access.json'), JSON.stringify(legacyAccess, null, 2))

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
    proc.stderr!.on('data', (c: Buffer) => { stderrLines.push(c.toString().trim()) })
    proc.on('error', err => { stderrLines.push(`proc error: ${err.message}`) })

    mcp = makeMcpReader(proc)

    const initResponse = mcp.wait<any>(
      m => (m as any).id === 1 && (m as any).result?.serverInfo !== undefined,
      20000,
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

    await mock.waitForCall('getMe', 0, 20000)
  }, 45000)

  afterAll(async () => {
    try { proc?.kill('SIGTERM') } catch {}
    await mock.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('sender excluded from the legacy allowFrom is dropped, even though the group itself is allowlisted', async () => {
    const t0 = Date.now()
    mcp.messages.length // touch to keep TS happy about usage ordering

    mock.queueUpdate(groupUpdate({
      msgId: 1,
      senderId: EXCLUDED_SENDER_ID,
      groupId: RESTRICTED_GROUP_ID,
      text: 'let me in',
    }))

    // Give Grammy time to poll and gate() time to run.
    await sleep(1500)

    const typingForExcluded = mock.calls.find(
      c => c.method === 'sendChatAction' && c.ts >= t0 &&
           Number(c.body['chat_id']) === RESTRICTED_GROUP_ID
    )
    expect(typingForExcluded).toBeUndefined()

    const notifForExcluded = mcp.messages.find(
      (m: any) => m.method === 'notifications/claude/channel' &&
                  Number(m.params?.meta?.chat_id) === RESTRICTED_GROUP_ID
    )
    expect(notifForExcluded).toBeUndefined()
  }, 15000)

  test('sender in the legacy allowFrom list is still delivered', async () => {
    const t0 = Date.now()

    mock.queueUpdate(groupUpdate({
      msgId: 2,
      senderId: ALLOWED_SENDER_ID,
      groupId: RESTRICTED_GROUP_ID,
      text: 'hello from an allowed sender',
    }))

    const typingCall = await mock.waitForCall('sendChatAction', t0, 20000)
    expect(Number(typingCall.body['chat_id'])).toBe(RESTRICTED_GROUP_ID)

    const notification = await mcp.wait<any>(
      m => (m as any).method === 'notifications/claude/channel' &&
           Number((m as any).params?.meta?.chat_id) === RESTRICTED_GROUP_ID,
      20000,
    )
    expect(notification.params.content).toBe('hello from an allowed sender')
    expect(notification.params.meta.user_id).toBe(String(ALLOWED_SENDER_ID))
  }, 30000)

  test('a group with no legacy restriction is unaffected (regression guard)', async () => {
    const t0 = Date.now()

    mock.queueUpdate(groupUpdate({
      msgId: 3,
      senderId: OPEN_GROUP_SENDER_ID,
      groupId: OPEN_GROUP_ID,
      text: 'anyone can talk here',
    }))

    const typingCall = await mock.waitForCall('sendChatAction', t0, 20000)
    expect(Number(typingCall.body['chat_id'])).toBe(OPEN_GROUP_ID)
  }, 30000)
})
