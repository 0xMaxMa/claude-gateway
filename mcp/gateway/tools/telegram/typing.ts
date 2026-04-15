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
  sendMessage(chatId: string, text: string, opts?: { parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown' }): Promise<{ message_id: number }>
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
          const msgOpts = parseMode ? { parse_mode: parseMode } : {}
          await botApi.sendMessage(chatId, forwardText, msgOpts).catch(() => {})
        }
      } catch {}
      fsApi.rmSync(forwardPath, { force: true })
    }
    fsApi.rmSync(repliedPath, { force: true })
    fsApi.rmSync(typingFilePath(chatId), { force: true })
    fsApi.rmSync(errorFilePath(chatId), { force: true })
    fsApi.rmSync(heartbeatFilePath(chatId), { force: true })
    fsApi.rmSync(statusFilePath(chatId), { force: true })
    fsApi.rmSync(msgIdFilePath(chatId), { force: true })
    if (state.statusMessageId !== null) {
      await botApi.deleteMessage(chatId, state.statusMessageId).catch(() => {})
    }
    states.delete(chatId)
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
        await botApi.sendMessage(
          chatId,
          '⚠️ Claude has not responded in 5 minutes. It may be waiting for input or stuck. Please try sending a new message.',
        ).catch(() => {})
        await stop(chatId)
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
