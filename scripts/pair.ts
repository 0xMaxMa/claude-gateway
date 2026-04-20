#!/usr/bin/env ts-node
/**
 * npm run pair -- --agent=<agentId> --code=<code> [--channel=telegram|discord]
 *
 * Multi-agent pairing helper for Claude Gateway.
 * Approves a pending pairing without needing an interactive Claude session.
 *
 * For Telegram (default):
 *  1. Reads {workspace}/.telegram-state/access.json
 *  2. Verifies the code exists and is not expired
 *  3. Adds senderId to allowFrom
 *  4. Writes {workspace}/.telegram-state/approved/<senderId> (content = chatId)
 *
 * For Discord (--channel=discord):
 *  1. Reads {workspace}/.discord-state/access.json
 *  2. Verifies the code exists and is not expired
 *  3. Adds senderId to allowFrom
 *  4. Writes {workspace}/.discord-state/approved/<senderId> (content = channelId)
 *
 * The module polls approved/ every 5 seconds and sends "Paired! Say hi to Claude."
 * when it detects the file.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) {
      result[m[1]] = m[2] !== undefined ? m[2] : true
    }
  }
  return result
}

const args = parseArgs(process.argv)
const agentId = args['agent'] as string | undefined
const code = (args['code'] as string | undefined)?.toLowerCase()
const channel = (args['channel'] as string | undefined) ?? 'telegram'

if (!agentId || !code) {
  console.error('Usage: npm run pair -- --agent=<agentId> --code=<code> [--channel=telegram|discord]')
  process.exit(1)
}

if (channel !== 'telegram' && channel !== 'discord') {
  console.error(`Unknown channel "${channel}". Must be "telegram" or "discord".`)
  process.exit(1)
}

// Find gateway config
const configPath = (process.env.GATEWAY_CONFIG
  ? (process.env.GATEWAY_CONFIG.startsWith('~/')
    ? path.join(os.homedir(), process.env.GATEWAY_CONFIG.slice(2))
    : process.env.GATEWAY_CONFIG)
  : path.join(os.homedir(), '.claude-gateway', 'config.json'))

let config: { agents: Array<{ id: string; workspace: string }> }
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
  console.error(`Cannot read gateway config at ${configPath}: ${(err as Error).message}`)
  process.exit(1)
}

const agent = config.agents.find((a) => a.id === agentId)
if (!agent) {
  console.error(`Agent "${agentId}" not found in config`)
  console.error(`Available agents: ${config.agents.map(a => a.id).join(', ') || '(none)'}`)
  process.exit(1)
}

const workspace = agent.workspace.startsWith('~/')
  ? path.join(os.homedir(), agent.workspace.slice(2))
  : agent.workspace

if (channel === 'discord') {
  pairDiscord(workspace)
} else {
  pairTelegram(workspace)
}

function pairTelegram(workspace: string): void {
  const stateDir = path.join(workspace, '.telegram-state')
  const accessFile = path.join(stateDir, 'access.json')
  const approvedDir = path.join(stateDir, 'approved')

  let access: {
    dmPolicy: string
    allowFrom: string[]
    groups: Record<string, unknown>
    pending: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
  }
  try {
    access = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
  } catch (err) {
    console.error(`Cannot read access.json at ${accessFile}: ${(err as Error).message}`)
    process.exit(1)
  }

  if (!access.pending) {
    console.error(`No pending entries in access.json`)
    process.exit(1)
  }

  const entry = access.pending[code!]
  if (!entry) {
    console.error(`Code "${code}" not found in pending`)
    const pendingCodes = Object.keys(access.pending)
    if (pendingCodes.length > 0) {
      console.error(`Available pending codes: ${pendingCodes.join(', ')}`)
    } else {
      console.error(`No pending entries found`)
    }
    process.exit(1)
  }

  if (entry.expiresAt < Date.now()) {
    console.error(`Code "${code}" has expired (expired ${new Date(entry.expiresAt).toISOString()})`)
    process.exit(1)
  }

  const { senderId, chatId } = entry
  delete access.pending[code!]
  if (!access.allowFrom.includes(senderId)) {
    access.allowFrom.push(senderId)
  }

  const tmp = accessFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, accessFile)

  fs.mkdirSync(approvedDir, { recursive: true })
  fs.writeFileSync(path.join(approvedDir, senderId), chatId)

  console.log(`Paired: senderId=${senderId} for agent "${agentId}"`)
  console.log(`  State dir: ${stateDir}`)
  console.log(`  Plugin will send confirmation message within 5s.`)
}

function pairDiscord(workspace: string): void {
  const stateDir = path.join(workspace, '.discord-state')
  const accessFile = path.join(stateDir, 'access.json')
  const approvedDir = path.join(stateDir, 'approved')

  let access: {
    dmPolicy: string
    allowFrom: string[]
    guildAllowlist: string[]
    channelAllowlist: string[]
    roleAllowlist: string[]
    pending: Record<string, { senderId: string; channelId: string; createdAt: number; expiresAt: number; replies: number }>
  }
  try {
    access = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
  } catch (err) {
    console.error(`Cannot read access.json at ${accessFile}: ${(err as Error).message}`)
    process.exit(1)
  }

  if (!access.pending) {
    console.error(`No pending entries in access.json`)
    process.exit(1)
  }

  const entry = access.pending[code!]
  if (!entry) {
    console.error(`Code "${code}" not found in pending`)
    const pendingCodes = Object.keys(access.pending)
    if (pendingCodes.length > 0) {
      console.error(`Available pending codes: ${pendingCodes.join(', ')}`)
    } else {
      console.error(`No pending entries found`)
    }
    process.exit(1)
  }

  if (entry.expiresAt < Date.now()) {
    console.error(`Code "${code}" has expired (expired ${new Date(entry.expiresAt).toISOString()})`)
    process.exit(1)
  }

  const { senderId, channelId } = entry
  delete access.pending[code!]
  if (!access.allowFrom.includes(senderId)) {
    access.allowFrom.push(senderId)
  }

  const tmp = accessFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, accessFile)

  fs.mkdirSync(approvedDir, { recursive: true })
  fs.writeFileSync(path.join(approvedDir, senderId), channelId)

  console.log(`Paired: senderId=${senderId} for agent "${agentId}" (discord)`)
  console.log(`  State dir: ${stateDir}`)
  console.log(`  Module will send confirmation message within 5s.`)
}
