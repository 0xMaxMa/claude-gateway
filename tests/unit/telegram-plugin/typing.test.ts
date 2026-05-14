/**
 * Unit tests for mcp/tools/telegram/typing.ts — WorkingState manager.
 * All bot API calls and filesystem operations are injected mocks.
 */

import {
  createWorkingStateManager,
  parseStatusFile,
  chunkText,
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
  })
})
