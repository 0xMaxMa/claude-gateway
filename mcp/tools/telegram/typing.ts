/**
 * Typing indicator and working state management for the Telegram receiver.
 *
 * Coordinates between two separate processes that share STATE_DIR:
 *   - Receiver (TELEGRAM_RECEIVER_MODE): starts the typing loop on inbound message
 *   - SEND_ONLY (TELEGRAM_SEND_ONLY): signals completion by deleting the signal file
 *   - SessionProcess: writes heartbeat on every stdout line to prove Claude is active
 *   - AgentRunner: signals errors by writing a .error file
 *
 * IPC mechanism: filesystem signals in STATE_DIR/typing/
 *   STATE_DIR/typing/{chatId}           — created by receiver, deleted by SEND_ONLY
 *   STATE_DIR/typing/{chatId}.heartbeat — written by SessionProcess on each output line
 *   STATE_DIR/typing/{chatId}.error     — written by AgentRunner on session failure
 */

export const TELEGRAM_MAX_CHARS = 4096

/**
 * Telegram rejects a message whose HTML entities are unbalanced, so a chunk cut
 * that falls inside a <pre><code>…</code></pre> block must close the open tags
 * at the end of the chunk and reopen them at the start of the next one.
 * Reserve room for that worst-case suffix (</a></code></pre></b></i>) plus the
 * mirrored reopening prefix so balancing never pushes a chunk past the limit.
 */
const HTML_BALANCE_HEADROOM = 64

/** Tags toTelegramHtml() emits — the only ones balancing needs to understand. */
const BALANCED_TAGS = ['b', 'i', 'code', 'pre', 'a'] as const

/**
 * Scan an HTML fragment (as produced by toTelegramHtml — no attributes except
 * <a href>, no self-closing forms) and return the stack of tags still open at
 * the end, as full opening-tag strings in opening order.
 */
export function openTagStack(html: string): string[] {
  const stack: string[] = []
  // Attribute part tolerates '>' inside quoted values (<a href="a>b">).
  const re = /<(\/?)([a-z]+)((?:\s(?:"[^"]*"|[^>])*)?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/'
    const name = m[2]
    if (!(BALANCED_TAGS as readonly string[]).includes(name)) continue
    if (closing) {
      // toTelegramHtml emits well-nested pairs, so the match is always the top.
      const top = stack.length - 1
      if (top >= 0 && /^<([a-z]+)/.exec(stack[top])?.[1] === name) stack.pop()
    } else {
      stack.push(`<${name}${m[3] ?? ''}>`)
    }
  }
  return stack
}

/** Strip Telegram-HTML tags and unescape entities → plain-text equivalent. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/**
 * Split text into chunks that fit within Telegram's message size limit.
 * Prefers paragraph → line → space boundaries over hard cuts.
 * When htmlSafe=true, avoids cutting inside an HTML tag (e.g. <code>, <b>) AND
 * keeps every chunk entity-balanced: tags left open at a cut are closed at the
 * chunk's end and reopened at the next chunk's start, so no chunk is ever
 * rejected by Telegram's HTML parser for an unclosed <pre>/<code>/<b>.
 */
export function chunkText(text: string, limit = TELEGRAM_MAX_CHARS, htmlSafe = false): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  const effLimit = htmlSafe ? limit - HTML_BALANCE_HEADROOM : limit
  // If cut lands inside an open tag (<...>), move cut to before the '<'
  const avoidMidTag = (cut: number): number => {
    const tagStart = rest.lastIndexOf('<', cut)
    const tagEnd = rest.lastIndexOf('>', cut)
    return tagStart > tagEnd ? tagStart : cut
  }
  const closersFor = (open: string[]): string =>
    open.map((t) => `</${/^<([a-z]+)/.exec(t)![1]}>`).reverse().join('')
  // Cut at `cut`, balancing tags across the boundary when htmlSafe.
  const splitAt = (cut: number): { head: string; tail: string } => {
    let head = rest.slice(0, cut)
    let tail = rest.slice(cut).replace(/^\n+/, '')
    if (htmlSafe) {
      const open = openTagStack(head)
      if (open.length) {
        head += closersFor(open)
        tail = open.join('') + tail
      }
    }
    return { head, tail }
  }
  while (rest.length > effLimit) {
    const para = rest.lastIndexOf('\n\n', effLimit)
    const line = rest.lastIndexOf('\n', effLimit)
    const space = rest.lastIndexOf(' ', effLimit)
    let cut = para > effLimit / 2 ? para : line > effLimit / 2 ? line : space > 0 ? space : effLimit
    if (htmlSafe) cut = avoidMidTag(cut)
    let { head, tail } = splitAt(cut)
    // Forward-progress guard: when the chosen boundary sits right after an
    // opening tag (e.g. "<b> " + one unbroken >limit token), the reopened tag
    // prefix can re-add as much as the cut removed and `rest` never shrinks —
    // an infinite loop that would hang the whole receiver. Retry with a hard
    // cut at effLimit; if even that cannot shrink (degenerate tag-heavy input,
    // e.g. a single huge <a href>), emit the remainder as one oversized chunk
    // and stop — Telegram rejects it and the plain-text retry rescues the
    // content, which beats hanging the process.
    if (tail.length >= rest.length) {
      cut = htmlSafe ? avoidMidTag(effLimit) : effLimit
      ;({ head, tail } = splitAt(cut))
      if (tail.length >= rest.length) {
        out.push(rest)
        rest = ''
        break
      }
    }
    out.push(head)
    rest = tail
  }
  if (rest) out.push(rest)
  return out
}

export const STATUS_MESSAGES = [
  '⏳ Thinking...',
  '🔍 Analyzing your request...',
  '⚙️ Working on it...',
  '📝 Preparing a response...',
  '🧠 Processing, please wait...',
]

export const STALLED_TIMEOUT_MS = 300_000  // 5 minutes without heartbeat → warn + stop
export const STALLED_CHECK_INTERVAL_MS = 15_000  // check heartbeat freshness every 15s
export const TYPING_INTERVAL_MS = 4_000    // sendChatAction every 4s (Telegram expires at 5s)
export const STATUS_INTERVAL_MS = 10_000   // status update every 10s
export const STATUS_INITIAL_DELAY_MS = 5_000  // first status message after 5s

export const ERROR_MESSAGES: Record<string, string> = {
  PROCESS_FAILED: '❌ Claude stopped unexpectedly. Please try sending a new message.',
  POOL_FULL: '⚠️ Too many concurrent sessions. Please try again in a moment.',
  SPAWN_FAILED: '❌ Failed to start Claude session. Please try again.',
}

export const STATUS_EMOJI: Record<string, string> = {
  queued:   '👀',
  thinking: '🤔',
  tool:     '🔥',
  coding:   '👨\u200d💻',
  waiting:  '⏳',
  done:     '👍',
  error:    '😱',
}

export function parseStatusFile(content: string): { status: string; detail?: string } {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.status === 'string') {
      return { status: parsed.status, detail: typeof parsed.detail === 'string' ? parsed.detail : undefined };
    }
  } catch {}
  return { status: content.trim() };
}

export interface WorkingState {
  typingInterval: ReturnType<typeof setInterval>
  statusInterval: ReturnType<typeof setInterval>
  stalledInterval: ReturnType<typeof setInterval>
  initialStatusTimer: ReturnType<typeof setTimeout> | null
  statusMessageId: number | null
  startedAt: number
  currentReaction: string | null
  lastDetail: string | null
  recentDetails: string[]
}

export interface BotApi {
  sendChatAction(chatId: string, action: 'typing'): Promise<unknown>
  sendMessage(chatId: string, text: string, opts?: { parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown'; reply_markup?: unknown }): Promise<{ message_id: number }>
  editMessageText(chatId: string, msgId: number, text: string): Promise<unknown>
  deleteMessage(chatId: string, msgId: number): Promise<unknown>
  setMessageReaction(chatId: string, msgId: number, emoji: string): Promise<unknown>
}

export interface FsApi {
  mkdirSync(path: string, opts: { recursive: boolean }): void
  writeFileSync(path: string, data: string): void
  existsSync(path: string): boolean
  rmSync(path: string, opts: { force: boolean }): void
  readFileSync(path: string, enc: BufferEncoding): string
  statSync(path: string): { mtimeMs: number }
}

/**
 * Deliver auto-forwarded turn text to a chat, never silently dropping content.
 * Each chunk that fails as HTML (e.g. Telegram rejects an entity the balancer
 * didn't anticipate) is retried as plain text — the user always gets the words,
 * worst case without formatting. The generic "could not be delivered" notice is
 * a last resort reserved for chunks that fail even as plain text (network/API
 * outage), and is sent at most once.
 */
export async function deliverForwardText(
  botApi: Pick<BotApi, 'sendMessage'>,
  chatId: string,
  forwardText: string,
  parseMode: 'HTML' | undefined,
): Promise<void> {
  const msgOpts = parseMode ? { parse_mode: parseMode } : {}
  const chunks = chunkText(forwardText, TELEGRAM_MAX_CHARS, parseMode === 'HTML')
  let deliveryFailed = false
  for (const part of chunks) {
    try {
      await botApi.sendMessage(chatId, part, msgOpts)
    } catch {
      const plain = parseMode === 'HTML' ? htmlToPlain(part) : part
      try {
        await botApi.sendMessage(chatId, plain)
      } catch {
        deliveryFailed = true
        break
      }
    }
  }
  if (deliveryFailed) {
    await botApi.sendMessage(
      chatId,
      '⚠️ Claude responded but the message could not be delivered. Please try asking again.',
    ).catch(() => {})
  }
}

/**
 * Orphan auto-forward delivery (one poll pass). The typing-loop teardown
 * (stop()) normally drains `<chatId>.forward`, but a forward can be written
 * with NO typing loop running at all: an autonomous wake (a background Task
 * finished and Claude continued on its own — e.g. writing up a plan) has no
 * inbound message, so nothing ever started typing and stop() never runs.
 * Without this drain that text sits on disk forever and the user sees a
 * silent chat. Chats with a live typing state are skipped — stop() owns
 * their delivery (including the .replied dedup) and draining them here
 * would double-send.
 */
export function drainOrphanForwards(
  typingDir: string,
  activeChatIds: { has(chatId: string): boolean },
  botApi: Pick<BotApi, 'sendMessage'>,
  fsApi: Pick<FsApi, 'existsSync' | 'rmSync' | 'readFileSync'> & { readdirSync(path: string): string[] },
): void {
  let files: string[]
  try {
    files = fsApi.readdirSync(typingDir)
  } catch {
    return
  }
  for (const name of files) {
    if (!name.endsWith('.forward')) continue
    const chatId = name.slice(0, -'.forward'.length)
    if (activeChatIds.has(chatId)) continue
    const forwardPath = `${typingDir}/${name}`
    let raw: string
    try {
      raw = fsApi.readFileSync(forwardPath, 'utf8').trim()
    } catch {
      fsApi.rmSync(forwardPath, { force: true })
      continue
    }
    // Remove BEFORE sending so a slow/failing send can't double-deliver.
    fsApi.rmSync(forwardPath, { force: true })
    // Mirror stop()'s dedup: a lingering .replied with no typing state means
    // the agent already sent this turn's text via the reply tool.
    const repliedPath = `${typingDir}/${chatId}.replied`
    if (fsApi.existsSync(repliedPath)) {
      fsApi.rmSync(repliedPath, { force: true })
      continue
    }
    let text = raw
    let parseMode: 'HTML' | undefined
    try {
      const parsed = JSON.parse(raw) as { text: string; format: string }
      text = parsed.text
      parseMode = parsed.format === 'html' ? 'HTML' : undefined
    } catch {
      // Old format: plain text
    }
    if (text) void deliverForwardText(botApi, chatId, text, parseMode)
  }
}

export function createWorkingStateManager(
  typingDir: string,
  botApi: BotApi,
  fsApi: FsApi,
) {
  const states = new Map<string, WorkingState>()

  function typingFilePath(chatId: string): string {
    return `${typingDir}/${chatId}`
  }

  function errorFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.error`
  }

  function heartbeatFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.heartbeat`
  }

  function statusFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.status`
  }

  function processingFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.processing`
  }

  function msgIdFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.msgid`
  }

  function forwardFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.forward`
  }

  function repliedFilePath(chatId: string): string {
    return `${typingDir}/${chatId}.replied`
  }

  async function stop(chatId: string): Promise<void> {
    const state = states.get(chatId)
    if (!state) return
    clearInterval(state.typingInterval)
    clearInterval(state.statusInterval)
    clearInterval(state.stalledInterval)
    if (state.initialStatusTimer) clearTimeout(state.initialStatusTimer)
    // Read final status and set done/error reaction before cleanup
    const statusPath = statusFilePath(chatId)
    const msgIdPath = msgIdFilePath(chatId)
    if (fsApi.existsSync(statusPath) && fsApi.existsSync(msgIdPath)) {
      try {
        const raw = fsApi.readFileSync(statusPath, 'utf8')
        const { status: finalStatus } = parseStatusFile(raw)
        const msgId = parseInt(fsApi.readFileSync(msgIdPath, 'utf8').trim(), 10)
        const emoji = STATUS_EMOJI[finalStatus] ?? STATUS_EMOJI['done']
        if (!isNaN(msgId) && emoji && state.currentReaction !== emoji) {
          await botApi.setMessageReaction(chatId, msgId, emoji).catch(() => {})
        }
      } catch {}
    }
    // Auto-forward result text to Telegram if the agent did not already reply with the same text.
    const forwardPath = forwardFilePath(chatId)
    const repliedPath = repliedFilePath(chatId)
    if (fsApi.existsSync(forwardPath)) {
      try {
        const raw = fsApi.readFileSync(forwardPath, 'utf8').trim()
        let forwardText: string
        let parseMode: 'HTML' | undefined
        try {
          const parsed = JSON.parse(raw) as { text: string; format: string }
          forwardText = parsed.text
          parseMode = parsed.format === 'html' ? 'HTML' : undefined
        } catch {
          // Fallback: treat as plain text (old format compatibility)
          forwardText = raw
          parseMode = undefined
        }
        // Skip if the reply tool already sent a message (agent already replied)
        const alreadyReplied = fsApi.existsSync(repliedPath)
        if (!alreadyReplied && forwardText) {
          await deliverForwardText(botApi, chatId, forwardText, parseMode)
        }
      } catch {}
      fsApi.rmSync(forwardPath, { force: true })
    }
    // NOTE: interactive-menu (.menu) delivery is handled by an independent poller
    // in receiver-server.ts (drainMenuFiles), NOT here. A menu can be emitted
    // after the typing state has already been torn down (reply tool called earlier
    // in the turn, or the turn ended), in which case this stop() never runs for it
    // and the .menu file would be orphaned. The standalone poller has no such
    // coupling, so it reliably delivers every menu. Do not re-add a drain here.
    fsApi.rmSync(repliedPath, { force: true })
    // Read signal file timestamp before deleting — process.ts overwrites it with a newer
    // timestamp when a queued turn is injected; if newer than this turn's startedAt it means
    // another turn is waiting and the loop must be restarted after cleanup.
    let signalRaw: string | null = null
    try { signalRaw = fsApi.readFileSync(typingFilePath(chatId), 'utf8').trim() } catch {}
    const signalTs = signalRaw ? parseInt(signalRaw, 10) : 0
    const hasQueuedTurn = signalTs > state.startedAt
    fsApi.rmSync(typingFilePath(chatId), { force: true })
    fsApi.rmSync(errorFilePath(chatId), { force: true })
    fsApi.rmSync(heartbeatFilePath(chatId), { force: true })
    fsApi.rmSync(statusFilePath(chatId), { force: true })
    fsApi.rmSync(msgIdFilePath(chatId), { force: true })
    fsApi.rmSync(processingFilePath(chatId), { force: true })
    if (state.statusMessageId !== null) {
      await botApi.deleteMessage(chatId, state.statusMessageId).catch(() => {})
    }
    states.delete(chatId)

    if (hasQueuedTurn) {
      start(chatId)
    }
  }

  async function notifyError(chatId: string, code: string): Promise<void> {
    const text = ERROR_MESSAGES[code] ?? '❌ An error occurred. Please try again.'
    await botApi.sendMessage(chatId, text).catch(() => {})
  }

  function start(chatId: string): void {
    if (states.has(chatId)) return

    fsApi.mkdirSync(typingDir, { recursive: true })
    fsApi.writeFileSync(typingFilePath(chatId), String(Date.now()))

    let tick = 0
    const startedAt = Date.now()

    const state: WorkingState = {
      typingInterval: null as unknown as ReturnType<typeof setInterval>,
      statusInterval: null as unknown as ReturnType<typeof setInterval>,
      stalledInterval: null as unknown as ReturnType<typeof setInterval>,
      initialStatusTimer: null,
      statusMessageId: null,
      startedAt,
      currentReaction: null,
      lastDetail: null,
      recentDetails: [],
    }
    states.set(chatId, state)

    // Shared function to send/edit the status message
    let statusUpdatePending = false
    async function sendStatusUpdate(): Promise<void> {
      const s = states.get(chatId)
      if (!s || statusUpdatePending) return
      statusUpdatePending = true
      try {
        const totalSecs = Math.floor((Date.now() - s.startedAt) / 1000)
        const hours = Math.floor(totalSecs / 3600)
        const mins = Math.floor((totalSecs % 3600) / 60)
        const secs = totalSecs % 60
        const elapsedStr = hours > 0
          ? `${hours}h ${mins}m`
          : mins > 0
            ? secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
            : `${secs}s`
        const currentLine = s.lastDetail ?? STATUS_MESSAGES[tick % STATUS_MESSAGES.length]!
        tick++
        // Build multi-line status: history (☑️) + current (🕐) + elapsed
        const historyLines = s.recentDetails.slice(-4);
        const hasHistory = historyLines.length > 0
        const formattedHistory = hasHistory ? historyLines.map(d => `☑️ : ${d}`) : []
        const formattedCurrent = hasHistory ? `🕐 : ${currentLine}` : currentLine
        const lines = [...formattedHistory, formattedCurrent, `(elapsed: ${elapsedStr})`]
        const text = lines.join('\n')
        if (s.statusMessageId === null) {
          try {
            const sent = await botApi.sendMessage(chatId, text)
            s.statusMessageId = sent.message_id
          } catch {}
        } else {
          await botApi.editMessageText(chatId, s.statusMessageId, text).catch(async () => {
            const current = states.get(chatId)
            if (current) current.statusMessageId = null
          })
        }
      } finally {
        statusUpdatePending = false
      }
    }

    state.typingInterval = setInterval(() => {
      // File deleted by SEND_ONLY (reply sent) → stop loop
      if (!fsApi.existsSync(typingFilePath(chatId))) {
        void stop(chatId)
        return
      }
      // Error file written by AgentRunner → notify user + stop
      if (fsApi.existsSync(errorFilePath(chatId))) {
        let code = 'UNKNOWN'
        try { code = fsApi.readFileSync(errorFilePath(chatId), 'utf8').trim() } catch {}
        void notifyError(chatId, code).then(() => stop(chatId))
        return
      }
      void botApi.sendChatAction(chatId, 'typing').catch(() => {})
      // Read .status + .msgid files and update reaction if state changed
      const statusPath = statusFilePath(chatId)
      const msgIdPath = msgIdFilePath(chatId)
      if (fsApi.existsSync(statusPath) && fsApi.existsSync(msgIdPath)) {
        try {
          const raw = fsApi.readFileSync(statusPath, 'utf8')
          const { status, detail } = parseStatusFile(raw)
          const msgId = parseInt(fsApi.readFileSync(msgIdPath, 'utf8').trim(), 10)
          const emoji = STATUS_EMOJI[status]
          const s = states.get(chatId)
          if (emoji && !isNaN(msgId) && s && s.currentReaction !== emoji) {
            s.currentReaction = emoji
            void botApi.setMessageReaction(chatId, msgId, emoji).catch(() => {})
          }
          // Update detail and immediately send status when it changes
          if (s && detail && detail !== s.lastDetail) {
            if (s.lastDetail) {
              s.recentDetails.push(s.lastDetail)
              // Keep only last 4 history entries
              if (s.recentDetails.length > 4) s.recentDetails.shift()
            }
            s.lastDetail = detail
            void sendStatusUpdate()
          }
        } catch {}
      }
    }, TYPING_INTERVAL_MS)

    // First status message after 5s, then recurring every 10s
    state.initialStatusTimer = setTimeout(() => {
      void sendStatusUpdate()
    }, STATUS_INITIAL_DELAY_MS)

    state.statusInterval = setInterval(async () => {
      await sendStatusUpdate()
    }, STATUS_INTERVAL_MS)

    // Stalled detection: check heartbeat file freshness every STALLED_CHECK_INTERVAL_MS.
    // If heartbeat was not updated within STALLED_TIMEOUT_MS → Claude is genuinely stuck.
    // Heartbeat file is written by SessionProcess on every Claude stdout line.
    state.stalledInterval = setInterval(async () => {
      if (!states.has(chatId)) return
      const hbPath = heartbeatFilePath(chatId)
      let lastActivity = startedAt
      if (fsApi.existsSync(hbPath)) {
        try { lastActivity = fsApi.statSync(hbPath).mtimeMs } catch {}
      }
      if (Date.now() - lastActivity >= STALLED_TIMEOUT_MS) {
        const s = states.get(chatId)
        // A .processing sentinel written during this turn (mtime >= startedAt) means the
        // session is genuinely mid-turn (e.g., waiting for a sub-agent). We can't know
        // whether it's still making progress, so we keep typing alive but stop noisy
        // status/stalled intervals and warn the user of the uncertainty.
        let isMidTurn = false
        try {
          const mtime = fsApi.statSync(processingFilePath(chatId)).mtimeMs
          isMidTurn = mtime >= startedAt
        } catch {}

        if (s && isMidTurn) {
          await botApi.sendMessage(
            chatId,
            '⚠️ No output for 5 min — may be a long sub-agent task or stuck. Typing is still active. Send a new message to cancel if needed.',
          ).catch(() => {})
          clearInterval(s.stalledInterval)
          clearInterval(s.statusInterval)
          if (s.initialStatusTimer) clearTimeout(s.initialStatusTimer)
          s.initialStatusTimer = null
        } else {
          await botApi.sendMessage(
            chatId,
            '⚠️ Claude has not responded in 5 minutes. It may be waiting for input or stuck. Please try sending a new message.',
          ).catch(() => {})
          await stop(chatId)
        }
      }
    }, STALLED_CHECK_INTERVAL_MS)
  }

  /**
   * Called by SEND_ONLY mode when the reply tool is invoked.
   * Removes the signal file so the receiver's typing loop stops on next tick.
   */
  function signalReplyDone(chatId: string): void {
    fsApi.rmSync(typingFilePath(chatId), { force: true })
  }

  return { start, stop, signalReplyDone, notifyError, states }
}
