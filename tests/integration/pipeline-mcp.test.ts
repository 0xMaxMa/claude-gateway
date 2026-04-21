/**
 * Pipeline MCP Integration Test — Step-by-step trace
 *
 * Verifies the full message pipeline through agent-runner:
 *
 *   Step 1 — Telegram → MCP
 *     User sends a Telegram message → mock Telegram Bot API receives getUpdates poll
 *     → Grammy delivers update → plugin calls sendChatAction('typing')
 *
 *   Step 2 — MCP plugin emits notification
 *     plugin.handleInbound() → mcp.notification(notifications/claude/channel)
 *     → client (mock Claude) receives the notification on its MCP connection
 *
 *   Step 3 — Plugin → Claude Code (mock)
 *     agent-runner spawns mock-claude-mcp as the Claude binary
 *     mock-claude-mcp reads --mcp-config → spawns plugin → MCP handshake
 *     → receives notifications/claude/channel → writes to stdout
 *     agent-runner emits 'output' event → test verifies content
 *
 * Requires `bun` on PATH (plugin runs under bun).
 */

import { spawn } from 'child_process'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as net from 'net'
import { AgentRunner } from '../../src/agent/runner'
import { AgentConfig, GatewayConfig } from '../../src/types'

const MOCK_CLAUDE_MCP_BIN = path.resolve(__dirname, '../helpers/mock-claude-mcp.js')
const BOT_TOKEN = 'test_pipeline_mcp_token'
const USER_ID = '777888999'

// ── helpers ──────────────────────────────────────────────────────────────────

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
  let updateIdCounter = 100

  function flushWaiters() {
    const ws = pollWaiters.splice(0)
    for (const w of ws) w()
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
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
          ok({ id: 11111, is_bot: true, username: 'pipeline_testbot', first_name: 'PipelineTest' })
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
            message_id: 200,
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
    close: () => new Promise<void>((res) => server.close(() => res())),
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function makeAgentConfig(workspace: string, botToken: string, telegramApiRoot: string): AgentConfig {
  return {
    id: 'pipeline-test-agent',
    description: 'Pipeline MCP test agent',
    workspace,
    env: '',
    telegram: {
      botToken,
    },
    claude: {
      model: 'claude-test',
      dangerouslySkipPermissions: true,
      extraFlags: [],
    },
  }
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: { logDir, timezone: 'UTC' },
    agents: [],
  }
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('Pipeline MCP — Telegram → plugin → Claude Code (step-by-step)', () => {
  let tmpDir: string
  let logDir: string
  let mock: ReturnType<typeof startMockTelegramServer>
  let runner: AgentRunner
  let collectedOutput: string[]
  let port: number

  beforeAll(async () => {
    // Check bun is available
    const { execSync } = await import('child_process')
    try {
      execSync('bun --version', { stdio: 'ignore' })
    } catch {
      console.warn('bun not found — skipping pipeline MCP tests')
      return
    }

    port = await getFreePort()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-mcp-'))
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-mcp-log-'))

    mock = startMockTelegramServer(port)

    collectedOutput = []

    // Use mock-claude-mcp as the Claude binary.
    // TELEGRAM_API_ROOT is set here so the plugin (spawned by mock-claude-mcp)
    // redirects API calls to our mock server.
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_MCP_BIN}`
    process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${port}`

    // Pre-pair USER_ID so messages are delivered (not dropped by gate)
    const access = {
      dmPolicy: 'allowlist',
      allowFrom: [USER_ID],
      groups: {},
      pending: {},
    }

    // workspace must be <base>/<agentId>/workspace so agentsBaseDir resolves correctly
    const workspace = path.join(tmpDir, 'pipeline-test-agent', 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    const agentCfg = makeAgentConfig(workspace, BOT_TOKEN, `http://127.0.0.1:${port}`)
    const gatewayCfg = makeGatewayConfig(logDir)

    // Pre-pair USER_ID in workspace state dir
    const workspaceStateDir = path.join(workspace, '.telegram-state')
    fs.mkdirSync(workspaceStateDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceStateDir, 'access.json'), JSON.stringify(access, null, 2))

    runner = new AgentRunner(agentCfg, gatewayCfg)
    runner.on('output', (line: string) => {
      collectedOutput.push(line)
    })

    await runner.start()

    // Wait for mock-claude-mcp to complete MCP handshake with plugin
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (collectedOutput.some(l => l.includes('[mock-claude-mcp] ready'))) break
      await sleep(100)
    }

    // Also wait for bot to be polling (getMe signals plugin is up)
    await mock.waitForCall('getMe', 0, 15000)
  }, 40000)

  afterAll(async () => {
    delete process.env.CLAUDE_BIN
    delete process.env.TELEGRAM_API_ROOT
    try { await runner?.stop() } catch {}
    await mock?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(logDir, { recursive: true, force: true })
  })

  // ── Step 1 ───────────────────────────────────────────────────────────────

  test('Step 1 — Telegram → MCP: plugin receives update and calls sendChatAction(typing)', async () => {
    const t0 = Date.now()

    mock.queueUpdate({
      message: {
        message_id: 1001,
        from: { id: Number(USER_ID), username: 'pipeline_tester', is_bot: false, first_name: 'PipelineUser' },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'step1 hello',
      },
    })

    // Plugin must have called sendChatAction('typing') on the Telegram API
    const typingCall = await mock.waitForCall('sendChatAction', t0, 10000)
    expect(typingCall.body['action']).toBe('typing')
    expect(String(typingCall.body['chat_id'])).toBe(USER_ID)
  }, 15000)

  // ── Step 2 ───────────────────────────────────────────────────────────────

  test('Step 2 — MCP: plugin emits notifications/claude/channel and mock Claude receives it', async () => {
    const t0 = Date.now()

    mock.queueUpdate({
      message: {
        message_id: 1002,
        from: { id: Number(USER_ID), username: 'pipeline_tester', is_bot: false, first_name: 'PipelineUser' },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'step2 mcp check',
      },
    })

    // Wait for the channel notification to appear in runner output
    const deadline = Date.now() + 10000
    let channelLine: string | undefined
    while (Date.now() < deadline) {
      channelLine = collectedOutput.find(
        l => l.includes('[mock-claude-mcp] channel:') && l.includes('step2 mcp check')
      )
      if (channelLine) break
      await sleep(100)
    }

    expect(channelLine).toBeDefined()

    const json = JSON.parse(channelLine!.replace('[mock-claude-mcp] channel: ', ''))
    expect(json.content).toBe('step2 mcp check')
    expect(json.meta.chat_id).toBe(USER_ID)
    expect(json.meta.user).toBe('pipeline_tester')
    expect(json.meta.message_id).toBe('1002')
  }, 15000)

  // ── Step 3 ───────────────────────────────────────────────────────────────

  test('Step 3 — Plugin → Claude Code: notification arrives via agent-runner output event', async () => {
    const t0 = Date.now()

    mock.queueUpdate({
      message: {
        message_id: 1003,
        from: { id: Number(USER_ID), username: 'pipeline_tester', is_bot: false, first_name: 'PipelineUser' },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'step3 claude receives',
      },
    })

    // agent-runner must emit 'output' event with the channel notification
    const deadline = Date.now() + 10000
    let outputLine: string | undefined
    while (Date.now() < deadline) {
      outputLine = collectedOutput.find(
        l => l.includes('[mock-claude-mcp] channel:') && l.includes('step3 claude receives')
      )
      if (outputLine) break
      await sleep(100)
    }

    expect(outputLine).toBeDefined()

    // Verify the notification was routed through agent-runner correctly
    const json = JSON.parse(outputLine!.replace('[mock-claude-mcp] channel: ', ''))
    expect(json.meta.chat_id).toBe(USER_ID)
    expect(json.content).toBe('step3 claude receives')
  }, 15000)

  // ── MCP config validation ─────────────────────────────────────────────────

  test('MCP config written by agent-runner has correct structure', () => {
    // MCP config is per-session: written at workspace/.sessions/<sessionUUID>/mcp-config.json
    const workspace = path.join(tmpDir, 'pipeline-test-agent', 'workspace')
    const sessionsDir = path.join(workspace, '.sessions')
    expect(fs.existsSync(sessionsDir)).toBe(true)
    // Scan for mcp-config.json in any session directory
    const sessionDirs = fs.readdirSync(sessionsDir)
    const sessionWithConfig = sessionDirs.find(d =>
      fs.existsSync(path.join(sessionsDir, d, 'mcp-config.json'))
    )
    expect(sessionWithConfig).toBeDefined()
    const mcpConfigPath = path.join(sessionsDir, sessionWithConfig!, 'mcp-config.json')

    const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'))
    expect(config.mcpServers).toBeDefined()
    expect(config.mcpServers.gateway).toBeDefined()

    const gw = config.mcpServers.gateway
    expect(gw.command).toBe('bun')
    expect(gw.args[0]).toMatch(/mcp\/server\.ts$/)
    expect(gw.env.TELEGRAM_BOT_TOKEN).toBe(BOT_TOKEN)
    expect(gw.env.TELEGRAM_STATE_DIR).toMatch(/\.telegram-state$/)
  })

  // ── agent-runner args validation ──────────────────────────────────────────

  test('agent-runner spawns Claude with --mcp-config and --channels flags', async () => {
    // Verify from the initial prompt line that Claude was launched
    const promptLine = collectedOutput.find(l => l.includes('[mock-claude-mcp] prompt:'))
    expect(promptLine).toBeDefined()
    expect(promptLine).toContain('Channels mode')
  })
})

// ── Step 3b: reply flow (separate runner with MOCK_CLAUDE_REPLY=1) ───────────

describe('Pipeline MCP — Step 3b: Claude calls reply tool → sendMessage', () => {
  let tmpDir2: string
  let logDir2: string
  let mock2: ReturnType<typeof startMockTelegramServer>
  let runner2: AgentRunner
  let collectedOutput2: string[]
  let port2: number

  beforeAll(async () => {
    const { execSync } = await import('child_process')
    try {
      execSync('bun --version', { stdio: 'ignore' })
    } catch {
      console.warn('bun not found — skipping step 3b')
      return
    }

    port2 = await getFreePort()
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-mcp2-'))
    logDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-mcp2-log-'))

    mock2 = startMockTelegramServer(port2)

    collectedOutput2 = []

    // Set MOCK_CLAUDE_REPLY=1 BEFORE spawning — the child process inherits env at spawn time
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_MCP_BIN}`
    process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${port2}`
    process.env.MOCK_CLAUDE_REPLY = '1'

    // workspace must be <base>/<agentId>/workspace so agentsBaseDir resolves correctly
    const workspace2 = path.join(tmpDir2, 'pipeline-test-agent-2', 'workspace')
    fs.mkdirSync(workspace2, { recursive: true })
    const agentCfg = makeAgentConfig(workspace2, BOT_TOKEN + '_2', `http://127.0.0.1:${port2}`)
    agentCfg.id = 'pipeline-test-agent-2'

    // Pre-pair USER_ID in workspace state dir
    const stateDir2 = path.join(workspace2, '.telegram-state')
    fs.mkdirSync(stateDir2, { recursive: true })
    fs.writeFileSync(path.join(stateDir2, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: [USER_ID],
      groups: {},
      pending: {},
    }, null, 2))
    const gatewayCfg = makeGatewayConfig(logDir2)

    runner2 = new AgentRunner(agentCfg, gatewayCfg)
    runner2.on('output', (line: string) => { collectedOutput2.push(line) })

    await runner2.start()

    // Wait for ready + bot polling
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (collectedOutput2.some(l => l.includes('[mock-claude-mcp] ready'))) break
      await sleep(100)
    }
    await mock2.waitForCall('getMe', 0, 15000)
  }, 40000)

  afterAll(async () => {
    delete process.env.MOCK_CLAUDE_REPLY
    delete process.env.CLAUDE_BIN
    delete process.env.TELEGRAM_API_ROOT
    try { await runner2?.stop() } catch {}
    await mock2?.close()
    if (tmpDir2) fs.rmSync(tmpDir2, { recursive: true, force: true })
    if (logDir2) fs.rmSync(logDir2, { recursive: true, force: true })
  })

  test('Step 3b — Claude calls reply tool → plugin sends sendMessage to Telegram API', async () => {
    const t0 = Date.now()

    mock2.queueUpdate({
      message: {
        message_id: 2001,
        from: { id: Number(USER_ID), username: 'pipeline_tester', is_bot: false, first_name: 'PipelineUser' },
        chat: { id: Number(USER_ID), type: 'private' },
        date: Math.floor(t0 / 1000),
        text: 'step3b reply test',
      },
    })

    // mock-claude-mcp receives the notification and immediately calls reply tool
    // plugin then calls sendMessage on the Telegram API.
    // Note: TelegramReceiver's typing manager may send a "Thinking..." status message
    // before the actual reply arrives, so we search for the echo reply specifically.
    const deadline = Date.now() + 12000
    let sendCall: MockCall | undefined
    while (Date.now() < deadline) {
      sendCall = mock2.calls.find(
        c => c.method === 'sendMessage' && c.ts >= t0 && String(c.body['text'] ?? '').includes('echo:')
      )
      if (sendCall) break
      await sleep(100)
    }
    expect(sendCall).toBeDefined()
    expect(String(sendCall!.body['chat_id'])).toBe(USER_ID)
    expect(sendCall!.body['text']).toMatch(/echo: step3b reply test/)
  }, 20000)
})
