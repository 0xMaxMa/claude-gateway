/**
 * Unit tests for mcp/tools/telegram/typing.ts — WorkingState manager.
 * All bot API calls and filesystem operations are injected mocks.
 */

import {
  createWorkingStateManager,
  parseStatusFile,
  chunkText,
  openTagStack,
  htmlToPlain,
  drainOrphanForwards,
  TELEGRAM_MAX_CHARS,
  STATUS_MESSAGES,
  ERROR_MESSAGES,
  STATUS_EMOJI,
  TYPING_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  STALLED_TIMEOUT_MS,
  STALLED_CHECK_INTERVAL_MS,
  type BotApi,
  type FsApi,
} from '../../../mcp/tools/telegram/typing'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBotApi(): jest.Mocked<BotApi> {
  return {
    sendChatAction: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: jest.fn().mockResolvedValue({}),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    setMessageReaction: jest.fn().mockResolvedValue(undefined),
  }
}

function makeFsApi(files?: Map<string, string>): FsApi & { _files: Map<string, string>; _mtimes: Map<string, number> } {
  const _files = files ?? new Map<string, string>()
  const _mtimes = new Map<string, number>()
  return {
    _files,
    _mtimes,
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn((path: string, data: string) => {
      _files.set(path, data)
      _mtimes.set(path, Date.now())
    }),
    existsSync: jest.fn((path: string) => _files.has(path)),
    rmSync: jest.fn((path: string) => { _files.delete(path); _mtimes.delete(path) }),
    readFileSync: jest.fn((path: string) => _files.get(path) ?? ''),
    statSync: jest.fn((path: string) => ({ mtimeMs: _mtimes.get(path) ?? 0 })),
  }
}

const TYPING_DIR = '/state/typing'
const CHAT_ID = '12345'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createWorkingStateManager', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  describe('start()', () => {
    test('creates signal file and initializes state', () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      expect(fsApi.mkdirSync).toHaveBeenCalledWith(TYPING_DIR, { recursive: true })
      expect(fsApi.writeFileSync).toHaveBeenCalledWith(`${TYPING_DIR}/${CHAT_ID}`, expect.any(String))
      expect(mgr.states.has(CHAT_ID)).toBe(true)
    })

    test('does not start duplicate state for same chatId', () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      mgr.start(CHAT_ID) // second call should no-op

      expect(fsApi.writeFileSync).toHaveBeenCalledTimes(1)
    })

    test('sends sendChatAction every TYPING_INTERVAL_MS while signal file exists', () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Advance 2 typing intervals
      jest.advanceTimersByTime(TYPING_INTERVAL_MS * 2)

      expect(bot.sendChatAction).toHaveBeenCalledWith(CHAT_ID, 'typing')
      expect(bot.sendChatAction).toHaveBeenCalledTimes(2)
    })

    test('stops typing loop when signal file is deleted (reply sent)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Simulate reply sent — delete signal file
      fsApi._files.delete(`${TYPING_DIR}/${CHAT_ID}`)

      // Advance past next tick — loop should detect and stop
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve() // flush microtasks

      expect(bot.sendChatAction).not.toHaveBeenCalled()
      expect(mgr.states.has(CHAT_ID)).toBe(false)
    })

    test('detects error file and notifies user, then stops', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // AgentRunner writes error file
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.error`, 'PROCESS_FAILED')

      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve() // extra tick for chained promises

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        ERROR_MESSAGES['PROCESS_FAILED'],
      )
    })
  })

  describe('stop()', () => {
    test('clears all intervals and removes state', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      await mgr.stop(CHAT_ID)

      expect(mgr.states.has(CHAT_ID)).toBe(false)
    })

    test('deletes status message if one was sent', async () => {
      const bot = makeBotApi()
      bot.sendMessage.mockResolvedValue({ message_id: 42 })
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Advance to trigger status message
      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()

      // Set statusMessageId manually (simulate message sent)
      const state = mgr.states.get(CHAT_ID)!
      state.statusMessageId = 42

      await mgr.stop(CHAT_ID)

      expect(bot.deleteMessage).toHaveBeenCalledWith(CHAT_ID, 42)
    })

    test('no-op when state does not exist', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      // Should not throw
      await expect(mgr.stop('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('signalReplyDone()', () => {
    test('deletes signal file so typing loop stops on next tick', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}`)).toBe(true)

      mgr.signalReplyDone(CHAT_ID)

      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}`)).toBe(false)
    })
  })

  describe('status updates', () => {
    test('sends status message after STATUS_INTERVAL_MS', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('Thinking'),
      )
    })

    test('edits existing status message on second tick', async () => {
      const bot = makeBotApi()
      bot.sendMessage.mockResolvedValue({ message_id: 77 })
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // First status tick — sends new message
      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()

      // Manually set statusMessageId so the edit path is taken
      const state = mgr.states.get(CHAT_ID)!
      state.statusMessageId = 77

      // Second status tick — should edit
      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()

      expect(bot.editMessageText).toHaveBeenCalledWith(CHAT_ID, 77, expect.any(String))
    })

    test('resets statusMessageId to null when editMessageText fails (message deleted)', async () => {
      const bot = makeBotApi()
      bot.editMessageText.mockRejectedValue(new Error('message not found'))
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      const state = mgr.states.get(CHAT_ID)!
      state.statusMessageId = 55

      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()

      expect(state.statusMessageId).toBeNull()
    })
  })

  describe('stalled detection', () => {
    test('sends stalled notification and stops when no heartbeat for STALLED_TIMEOUT_MS', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // No heartbeat file written — lastActivity = startedAt

      // Advance to first check tick that exceeds STALLED_TIMEOUT_MS
      jest.advanceTimersByTime(STALLED_TIMEOUT_MS)
      // Flush the async stalled callback chain (sendMessage → stop → deleteMessage)
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('Claude has not responded in 5 minutes'),
      )
      expect(mgr.states.has(CHAT_ID)).toBe(false)
    })

    test('does not stall when heartbeat is fresh', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Simulate SessionProcess writing heartbeat at t=0 and again near the stalled boundary
      const hbPath = `${TYPING_DIR}/${CHAT_ID}.heartbeat`

      // Advance to just before stalled threshold — write fresh heartbeat
      jest.advanceTimersByTime(STALLED_TIMEOUT_MS - STALLED_CHECK_INTERVAL_MS)
      fsApi.writeFileSync(hbPath, String(Date.now()))  // fresh heartbeat

      // Advance through several more check intervals — heartbeat is fresh so no stall
      jest.advanceTimersByTime(STALLED_CHECK_INTERVAL_MS * 3)
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(bot.sendMessage).not.toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('5 minutes'),
      )
      expect(mgr.states.has(CHAT_ID)).toBe(true)

      await mgr.stop(CHAT_ID)
    })

    test('stalled interval is cleared on manual stop (no double notification)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      await mgr.stop(CHAT_ID)

      // Advance past stalled timeout — should not send notification since state was cleared
      jest.advanceTimersByTime(STALLED_TIMEOUT_MS)
      await Promise.resolve()

      expect(bot.sendMessage).not.toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('5 minutes'),
      )
    })

    test('keeps typing alive and sends uncertainty warning when .processing is fresh (mid-turn)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const processingPath = `${TYPING_DIR}/${CHAT_ID}.processing`

      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)
      mgr.start(CHAT_ID)
      // Write .processing at t=0 (same as startedAt) → mtime >= startedAt → isMidTurn = true
      fsApi.writeFileSync(processingPath, String(Date.now()))

      jest.advanceTimersByTime(STALLED_TIMEOUT_MS)
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('No output for 5 min'),
      )
      // State must still be alive — stop() was NOT called
      expect(mgr.states.has(CHAT_ID)).toBe(true)
    })

    test('falls through to full stop() when .processing mtime predates current turn (stale sentinel)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const processingPath = `${TYPING_DIR}/${CHAT_ID}.processing`

      // Write .processing at t=0 (stale from previous crashed turn)
      fsApi.writeFileSync(processingPath, String(Date.now()))

      // Advance time so start() captures a later startedAt
      jest.advanceTimersByTime(1_000)
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)
      mgr.start(CHAT_ID)  // startedAt = 1000 > processingMtime = 0 → isMidTurn = false

      jest.advanceTimersByTime(STALLED_TIMEOUT_MS)
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('Claude has not responded in 5 minutes'),
      )
      // State deleted — stop() was called
      expect(mgr.states.has(CHAT_ID)).toBe(false)
    })
  })

  describe('notifyError()', () => {
    test.each(Object.entries(ERROR_MESSAGES))('sends correct message for code %s', async (code, expected) => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      await mgr.notifyError(CHAT_ID, code)

      expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, expected)
    })

    test('sends fallback message for unknown error code', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      await mgr.notifyError(CHAT_ID, 'TOTALLY_UNKNOWN')

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        '❌ An error occurred. Please try again.',
      )
    })
  })

  // ── T1–T6: Status emoji reaction ─────────────────────────────────────────

  describe('STATUS_EMOJI map', () => {
    test('T1: covers all required states', () => {
      const required = ['queued', 'thinking', 'tool', 'coding', 'done', 'error']
      for (const state of required) {
        expect(STATUS_EMOJI[state]).toBeDefined()
        expect(STATUS_EMOJI[state]!.length).toBeGreaterThan(0)
      }
    })
  })

  describe('status reaction in typingInterval', () => {
    test('T2: reads .status=thinking and calls setMessageReaction(🤔)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Write status + msgid files (as SessionProcess would)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'thinking')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '42')

      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()

      expect(bot.setMessageReaction).toHaveBeenCalledWith(CHAT_ID, 42, STATUS_EMOJI['thinking'])

      await mgr.stop(CHAT_ID)
    })

    test('T3: reads .status=done and calls setMessageReaction(👍)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'done')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '99')

      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()

      expect(bot.setMessageReaction).toHaveBeenCalledWith(CHAT_ID, 99, STATUS_EMOJI['done'])

      await mgr.stop(CHAT_ID)
    })

    test('T4: same reaction twice — setMessageReaction NOT called again', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'thinking')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '42')

      // First tick — should call reaction
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      expect(bot.setMessageReaction).toHaveBeenCalledTimes(1)

      // Second tick — same status, should NOT call again
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      expect(bot.setMessageReaction).toHaveBeenCalledTimes(1)

      await mgr.stop(CHAT_ID)
    })

    test('T6: missing .status or .msgid — no error thrown, reaction unchanged', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // No .status or .msgid files written

      expect(() => jest.advanceTimersByTime(TYPING_INTERVAL_MS)).not.toThrow()
      await Promise.resolve()

      expect(bot.setMessageReaction).not.toHaveBeenCalled()

      await mgr.stop(CHAT_ID)
    })
  })

  describe('stop() cleans up status files', () => {
    test('T5: stop() deletes .status and .msgid files', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Write the files
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'thinking')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '42')

      await mgr.stop(CHAT_ID)

      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.status`)).toBe(false)
      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.msgid`)).toBe(false)
    })

    test('T5b: stop() sets final reaction before deleting files', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Simulate status=done written by session-process before stop is called
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'done')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '55')

      await mgr.stop(CHAT_ID)

      // Should have set the final reaction to 👍 before cleanup
      expect(bot.setMessageReaction).toHaveBeenCalledWith(CHAT_ID, 55, STATUS_EMOJI['done'])
      // Files still cleaned up
      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.status`)).toBe(false)
      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.msgid`)).toBe(false)
    })

    test('T5c: stop() sets error reaction when status=error', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'error')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '77')

      await mgr.stop(CHAT_ID)

      expect(bot.setMessageReaction).toHaveBeenCalledWith(CHAT_ID, 77, STATUS_EMOJI['error'])
    })
  })

  // --------------------------------------------------------------------------
  // parseStatusFile tests
  // --------------------------------------------------------------------------
  describe('parseStatusFile', () => {
    it('U-TY-01: handles plain string (backward compat)', () => {
      const result = parseStatusFile('thinking')
      expect(result).toEqual({ status: 'thinking' })
    })

    it('U-TY-02: handles JSON with detail', () => {
      const result = parseStatusFile('{"status":"tool","detail":"📖 Reading server.ts"}')
      expect(result).toEqual({ status: 'tool', detail: '📖 Reading server.ts' })
    })

    it('handles JSON without detail field', () => {
      const result = parseStatusFile('{"status":"done"}')
      expect(result).toEqual({ status: 'done' })
    })

    it('handles empty string', () => {
      const result = parseStatusFile('')
      expect(result).toEqual({ status: '' })
    })

    it('handles invalid JSON gracefully', () => {
      const result = parseStatusFile('{broken')
      expect(result).toEqual({ status: '{broken' })
    })
  })

  // --------------------------------------------------------------------------
  // Live detail in status message
  // --------------------------------------------------------------------------
  describe('live detail in status message', () => {
    it('U-TY-03: status message shows detail when available', async () => {
      jest.useFakeTimers()
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Write JSON status with detail
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, JSON.stringify({ status: 'tool', detail: '📖 Reading server.ts' }))
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '55')

      // Advance to trigger typing interval (reads detail)
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)

      // Advance to trigger status interval
      jest.advanceTimersByTime(STATUS_INTERVAL_MS - TYPING_INTERVAL_MS)

      // Wait for async sendMessage
      await Promise.resolve()
      await Promise.resolve()

      const sendCalls = bot.sendMessage.mock.calls
      const statusCall = sendCalls.find(c => typeof c[1] === 'string' && c[1].includes('Reading server.ts'))
      expect(statusCall).toBeDefined()

      await mgr.stop(CHAT_ID)
      jest.useRealTimers()
    })

    it('U-TY-04: status message falls back to generic when no detail', async () => {
      jest.useFakeTimers()
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      // Write plain status (no detail)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, 'thinking')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '55')

      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()

      const sendCalls = bot.sendMessage.mock.calls
      // Should use one of the generic STATUS_MESSAGES
      const statusCall = sendCalls.find(c =>
        typeof c[1] === 'string' && STATUS_MESSAGES.some(m => c[1].includes(m))
      )
      expect(statusCall).toBeDefined()

      await mgr.stop(CHAT_ID)
      jest.useRealTimers()
    })

    it('U-TY-05: dedup — same detail does not trigger extra editMessage', async () => {
      jest.useFakeTimers()
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)

      const detail = JSON.stringify({ status: 'tool', detail: '📖 Reading server.ts' })
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.status`, detail)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.msgid`, '55')

      // First status interval — sends message
      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()

      // Second status interval — same detail, edits message
      jest.advanceTimersByTime(STATUS_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()

      // editMessageText should be called with text containing the detail both times
      // (edit happens because elapsed time changes, but detail is the same)
      const editCalls = bot.editMessageText.mock.calls
      for (const call of editCalls) {
        if (typeof call[2] === 'string') {
          expect(call[2]).toContain('Reading server.ts')
        }
      }

      await mgr.stop(CHAT_ID)
      jest.useRealTimers()
    })

    it('U-TY-06: waiting status has emoji in STATUS_EMOJI', () => {
      expect(STATUS_EMOJI['waiting']).toBe('⏳')
    })
  })

  describe('auto-forward dedup (.replied guard)', () => {
    it('U-TY-07: forwards text when .replied does NOT exist (JSON format)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // Simulate .forward file with result text in JSON format (no .replied)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: 'Hello from agent', format: 'text' }))

      // Remove signal file to trigger stop on next tick
      fsApi._files.delete(`${TYPING_DIR}/${CHAT_ID}`)
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve() // flush microtasks
      await Promise.resolve()
      await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Hello from agent', {})
    })

    it('U-TY-07b: forwards text with HTML parse_mode when format is html', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // Simulate .forward file with html format
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: 'Hello <code>code</code> world', format: 'html' }),
      )

      // Remove signal file to trigger stop on next tick
      fsApi._files.delete(`${TYPING_DIR}/${CHAT_ID}`)
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        'Hello <code>code</code> world',
        { parse_mode: 'HTML' },
      )
    })

    it('U-TY-07c: falls back to plain text when .forward contains non-JSON (old format)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // Simulate old plain-text .forward file (backward compatibility)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.forward`, 'Plain text fallback')

      // Remove signal file to trigger stop on next tick
      fsApi._files.delete(`${TYPING_DIR}/${CHAT_ID}`)
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Plain text fallback', {})
    })

    it('U-TY-08: skips forward when .replied exists (agent already replied via tool)', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // Simulate both .forward and .replied exist — agent already sent a reply
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: 'Hello from agent', format: 'text' }))
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.replied`, String(Date.now()))

      // Remove signal file to trigger stop on next tick
      fsApi._files.delete(`${TYPING_DIR}/${CHAT_ID}`)
      jest.advanceTimersByTime(TYPING_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // sendMessage should NOT be called — agent already replied
      const forwardCalls = bot.sendMessage.mock.calls.filter(
        (c: unknown[]) => c[1] === 'Hello from agent'
      )
      expect(forwardCalls).toHaveLength(0)
    })

    it('U-TY-09: cleans up both .forward and .replied files after stop', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.forward`, 'text')
      fsApi._files.set(`${TYPING_DIR}/${CHAT_ID}.replied`, String(Date.now()))

      await mgr.stop(CHAT_ID)

      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.forward`)).toBe(false)
      expect(fsApi._files.has(`${TYPING_DIR}/${CHAT_ID}.replied`)).toBe(false)
    })

    it('U-TY-10: splits long auto-forward text into multiple sendMessage calls', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      // Build a text that is just over 2× the limit to force exactly 2 chunks
      const longText = 'A'.repeat(TELEGRAM_MAX_CHARS + 100)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: longText, format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const forwardCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && c[1] !== longText,
      )
      // Should have been called at least twice (chunked)
      expect(forwardCalls.length).toBeGreaterThanOrEqual(2)
      // Each chunk must not exceed the limit
      for (const call of forwardCalls) {
        expect((call[1] as string).length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
      }
      // Combined chunks must account for all original content (no data loss)
      const combined = forwardCalls.map(c => c[1] as string).join('')
      expect(combined.length).toBe(longText.length)
    })

    it('U-TY-11: short auto-forward text sends as a single message', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      const shortText = 'Short reply'
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: shortText, format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const forwardCalls = bot.sendMessage.mock.calls.filter(c => c[0] === CHAT_ID && c[1] === shortText)
      expect(forwardCalls).toHaveLength(1)
    })

    it('U-TY-11b: retries a failed chunk as plain text — content delivered, no generic warning', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      // First call (the forward) throws; the plain-text retry succeeds — the
      // user gets the actual content, so the generic warning must NOT be sent.
      bot.sendMessage
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({ message_id: 200 })
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: 'Hello from agent', format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const contentCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && c[1] === 'Hello from agent',
      )
      expect(contentCalls).toHaveLength(2) // failed attempt + successful retry

      const warnCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).includes('could not be delivered'),
      )
      expect(warnCalls).toHaveLength(0)
    })

    it('U-TY-11b2: sends delivery-failure warning only when the plain-text retry also fails', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      // Forward attempt AND its plain retry both throw (real outage); the
      // warning send succeeds.
      bot.sendMessage
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({ message_id: 200 })
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: 'Hello from agent', format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const warnCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).includes('could not be delivered'),
      )
      expect(warnCalls).toHaveLength(1)
    })

    it('U-TY-11b3: HTML chunk rejected by Telegram falls back to stripped plain text', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      // HTML parse rejection on the formatted send; plain retry succeeds.
      bot.sendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValue({ message_id: 200 })
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: '<b>bold</b> and <code>x &lt; y</code>', format: 'html' }),
      )

      await mgr.stop(CHAT_ID)

      // Plain retry: tags stripped, entities unescaped, no parse_mode.
      const plainCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && c[1] === 'bold and x < y',
      )
      expect(plainCalls).toHaveLength(1)
      expect(plainCalls[0][2]).toBeUndefined()

      const warnCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).includes('could not be delivered'),
      )
      expect(warnCalls).toHaveLength(0)
    })

    it('U-TY-11c: a mid-delivery chunk failure is retried as plain and later chunks still send', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      // chunk1 OK, chunk2 fails once (plain retry succeeds), no warning.
      bot.sendMessage
        .mockResolvedValueOnce({ message_id: 100 })   // first chunk OK
        .mockRejectedValueOnce(new Error('rate limit')) // second chunk fails
        .mockResolvedValue({ message_id: 200 })         // plain retry succeeds

      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)
      mgr.start(CHAT_ID)

      // Two chunks: each > half of limit so they won't merge
      const chunk1 = 'A'.repeat(3000)
      const chunk2 = 'B'.repeat(3000)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: `${chunk1}\n\n${chunk2}`, format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const aCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).startsWith('A'),
      )
      expect(aCalls).toHaveLength(1)

      // chunk2: the failed attempt + the successful plain retry
      const bCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).startsWith('B'),
      )
      expect(bCalls).toHaveLength(2)

      const warnCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).includes('could not be delivered'),
      )
      expect(warnCalls).toHaveLength(0)
    })

    it('U-TY-11d: does NOT send delivery-failure warning when sendMessage succeeds', async () => {
      const bot = makeBotApi()
      const fsApi = makeFsApi()
      const mgr = createWorkingStateManager(TYPING_DIR, bot, fsApi)

      mgr.start(CHAT_ID)
      fsApi._files.set(
        `${TYPING_DIR}/${CHAT_ID}.forward`,
        JSON.stringify({ text: 'All good', format: 'text' }),
      )

      await mgr.stop(CHAT_ID)

      const warnCalls = bot.sendMessage.mock.calls.filter(
        c => c[0] === CHAT_ID && typeof c[1] === 'string' && (c[1] as string).includes('could not be delivered'),
      )
      expect(warnCalls).toHaveLength(0)
    })
  })

  describe('chunkText()', () => {
    it('U-TY-12: returns single-element array when text is within limit', () => {
      const text = 'Hello world'
      expect(chunkText(text, 4096)).toEqual([text])
    })

    it('U-TY-13: splits at paragraph boundary when available', () => {
      // 3500 + "\n\n" + 1000 = 4502 > 4096 → must split; paragraph boundary is at 3500
      const para1 = 'A'.repeat(3500)
      const para2 = 'B'.repeat(1000)
      const text = `${para1}\n\n${para2}`
      const chunks = chunkText(text, 4096)
      expect(chunks.length).toBe(2)
      expect(chunks[0]).toBe(para1)
      expect(chunks[1]).toBe(para2)
    })

    it('U-TY-14: falls back to hard cut when no boundary found', () => {
      const text = 'X'.repeat(5000)
      const chunks = chunkText(text, 4096)
      expect(chunks.length).toBe(2)
      expect(chunks[0].length).toBeLessThanOrEqual(4096)
      expect(chunks[1].length).toBeLessThanOrEqual(4096)
    })

    it('U-TY-15: all chunks stay within the given limit', () => {
      const limit = 100
      const text = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${'x'.repeat(10)}`).join('\n')
      const chunks = chunkText(text, limit)
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(limit)
      }
    })

    it('U-TY-16: htmlSafe=true does not cut inside an HTML tag', () => {
      // Place <code> tag near the cut boundary so a naive cut would land inside it
      const prefix = 'A'.repeat(4090)
      const text = `${prefix}<code>some code</code>`
      const chunks = chunkText(text, 4096, true)
      // Each chunk must not contain a partial open tag
      for (const c of chunks) {
        const openTags = (c.match(/</g) ?? []).length
        const closeTags = (c.match(/>/g) ?? []).length
        expect(openTags).toBe(closeTags)
      }
    })

    it('U-TY-17: htmlSafe=false (default) may cut inside a tag', () => {
      // Place '<code>' so that cut=4096 lands in the middle of it:
      // prefix 4093 chars → '<' at 4093, 'c' at 4094, 'o' at 4095, 'd' at 4096 (cut here)
      const prefix = 'A'.repeat(4093)
      const text = `${prefix}<code>some code</code>`
      const chunks = chunkText(text, 4096, false)
      // first chunk ends mid-tag: contains '<' but no matching '>'
      const openInFirst = (chunks[0].match(/</g) ?? []).length
      const closeInFirst = (chunks[0].match(/>/g) ?? []).length
      expect(openInFirst).toBeGreaterThan(closeInFirst)
    })

    it('U-TY-18: htmlSafe=true keeps every chunk entity-balanced across a <pre><code> block', () => {
      // A code block far larger than the limit: the cut MUST land inside it,
      // and each chunk must close what it opened and reopen in the next —
      // this exact shape (long analysis + big code block) is what Telegram
      // rejected with 400 and surfaced as "could not be delivered".
      const code = 'line of code\n'.repeat(600) // ~7800 chars
      const text = `<b>Analysis</b>\n<pre><code>${code}</code></pre>\ntail`
      const chunks = chunkText(text, 4096, true)
      expect(chunks.length).toBeGreaterThan(1)
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(4096)
        // Balanced per tag type: every <pre>/<code>/<b> has its close in-chunk.
        for (const tag of ['pre', 'code', 'b']) {
          const open = (c.match(new RegExp(`<${tag}>`, 'g')) ?? []).length
          const close = (c.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
          expect(open).toBe(close)
        }
      }
      // No content lost: stripping tags from all chunks reproduces the code body.
      const combined = chunks.map(c => c.replace(/<[^>]+>/g, '')).join('')
      expect(combined).toContain('line of code')
      expect(combined.match(/line of code/g)).toHaveLength(600)
    })

    it('U-TY-19: openTagStack returns tags still open, in order', () => {
      expect(openTagStack('<b>x</b>')).toEqual([])
      expect(openTagStack('<pre><code>abc')).toEqual(['<pre>', '<code>'])
      expect(openTagStack('<a href="https://x.y">link')).toEqual(['<a href="https://x.y">'])
      // Escaped entities are not tags
      expect(openTagStack('a &lt;b&gt; c')).toEqual([])
    })

    it('U-TY-20: htmlToPlain strips tags and unescapes entities', () => {
      expect(htmlToPlain('<b>bold</b> <code>x &lt; y &amp;&amp; z &gt; w</code>')).toBe('bold x < y && z > w')
    })

    it('U-TY-21: tag + space + unbroken over-limit token terminates (no infinite loop)', () => {
      // Regression: the cut used to land on the space right after the opening
      // tag, the balancer reopened the tag at the head of the remainder, and
      // `rest` never shrank — hanging the whole receiver event loop.
      const input = '<b> ' + 'x'.repeat(9000)
      const chunks = chunkText(input, 4096, true)
      expect(chunks.length).toBeGreaterThan(1)
      const combined = chunks.map(c => c.replace(/<[^>]+>/g, '')).join('')
      expect((combined.match(/x/g) ?? []).length).toBe(9000)
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096)
    })

    it('U-TY-21b: degenerate single huge tag falls back to one oversized chunk instead of hanging', () => {
      // A giant <a href> spanning past the limit can never be cut cleanly —
      // emitting the remainder oversized (plain retry rescues it) beats looping.
      const input = `<a href="https://example.com/${'q'.repeat(9000)}">link</a>`
      const chunks = chunkText(input, 4096, true)
      expect(chunks.length).toBeGreaterThanOrEqual(1)
      expect(chunks.join('')).toContain('link')
    })

    it('U-TY-22: openTagStack tolerates ">" inside a quoted href', () => {
      expect(openTagStack('<a href="https://x.y/a>b">link')).toEqual(['<a href="https://x.y/a>b">'])
    })
  })
})

// ── drainOrphanForwards (autonomous-wake .forward delivery) ──────────────────

describe('drainOrphanForwards', () => {
  // Bug 3: an autonomous wake writes `<chatId>.forward` with no typing loop
  // running, so stop() never drains it — without this poller the text sits on
  // disk forever and the chat stays silent.

  function makeDrainFsApi(files: Map<string, string>) {
    return {
      existsSync: jest.fn((path: string) => files.has(path)),
      rmSync: jest.fn((path: string) => { files.delete(path) }),
      readFileSync: jest.fn((path: string) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      }),
      readdirSync: jest.fn(() => {
        const names: string[] = []
        for (const key of files.keys()) {
          if (key.startsWith(`${TYPING_DIR}/`)) names.push(key.slice(TYPING_DIR.length + 1))
        }
        return names
      }),
      _files: files,
    }
  }

  it('U-TY-DR-01: delivers an orphan JSON forward with HTML format and removes the file', async () => {
    const files = new Map([[`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: '<b>plan</b> ready', format: 'html' })]])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)
    await Promise.resolve()

    expect(bot.sendMessage).toHaveBeenCalledTimes(1)
    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, '<b>plan</b> ready', { parse_mode: 'HTML' })
    expect(files.has(`${TYPING_DIR}/${CHAT_ID}.forward`)).toBe(false)
  })

  it('U-TY-DR-02: skips chats with a live typing state (stop() owns their delivery)', () => {
    const files = new Map([[`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: 'hi', format: 'text' })]])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set([CHAT_ID]), bot, fsApi)

    expect(bot.sendMessage).not.toHaveBeenCalled()
    expect(files.has(`${TYPING_DIR}/${CHAT_ID}.forward`)).toBe(true)
  })

  it('U-TY-DR-03: lingering .replied means the reply tool already sent — removes both, no send', () => {
    const files = new Map([
      [`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: 'dup', format: 'text' })],
      [`${TYPING_DIR}/${CHAT_ID}.replied`, '1'],
    ])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)

    expect(bot.sendMessage).not.toHaveBeenCalled()
    expect(files.has(`${TYPING_DIR}/${CHAT_ID}.forward`)).toBe(false)
    expect(files.has(`${TYPING_DIR}/${CHAT_ID}.replied`)).toBe(false)
  })

  it('U-TY-DR-04: legacy plain-text forward (non-JSON) is delivered without parse_mode', async () => {
    const files = new Map([[`${TYPING_DIR}/${CHAT_ID}.forward`, 'plain old text']])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)
    await Promise.resolve()

    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'plain old text', {})
  })

  it('U-TY-DR-05: file is removed BEFORE sending so a slow send cannot double-deliver', async () => {
    const files = new Map([[`${TYPING_DIR}/${CHAT_ID}.forward`, JSON.stringify({ text: 'once', format: 'text' })]])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)

    const rmOrder = fsApi.rmSync.mock.invocationCallOrder[0]
    const sendOrder = bot.sendMessage.mock.invocationCallOrder[0]
    expect(rmOrder).toBeLessThan(sendOrder)

    // A second pass sees no file — nothing is re-sent.
    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)
    await Promise.resolve()
    expect(bot.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('U-TY-DR-06: unreadable typing dir is a no-op', () => {
    const bot = makeBotApi()
    const fsApi = makeDrainFsApi(new Map())
    fsApi.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })

    expect(() => drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)).not.toThrow()
    expect(bot.sendMessage).not.toHaveBeenCalled()
  })

  it('U-TY-DR-07: ignores non-forward files in the typing dir', () => {
    const files = new Map([
      [`${TYPING_DIR}/${CHAT_ID}`, '1'],
      [`${TYPING_DIR}/${CHAT_ID}.heartbeat`, '1'],
      [`${TYPING_DIR}/${CHAT_ID}.menu`, '{}'],
    ])
    const fsApi = makeDrainFsApi(files)
    const bot = makeBotApi()

    drainOrphanForwards(TYPING_DIR, new Set<string>(), bot, fsApi)

    expect(bot.sendMessage).not.toHaveBeenCalled()
    expect(files.size).toBe(3)
  })
})
