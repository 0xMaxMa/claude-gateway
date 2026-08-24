import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../../src/session/store';
import { SessionCompactor, NotEnoughMessagesError, type ClaudeCliSpawnFn, type ClaudeCliResult } from '../../src/session/compactor';
import { Message } from '../../src/types';

// ── Fake `claude` CLI spawn (injected — see reviewer.ts's ClaudeSpawnFn for the
//    same convention) ──────────────────────────────────────────────────────────

function makeSpawnSuccess(stdout: string): ClaudeCliResult {
  return { status: 0, stdout, stderr: '' };
}

function makeSpawnError(status: number, stderr = 'CLI Error'): ClaudeCliResult {
  return { status, stdout: '', stderr };
}

/** Records every call and returns queued results in order; extra calls repeat the last result. */
function queueSpawn(...results: ClaudeCliResult[]): { spawn: ClaudeCliSpawnFn; calls: Array<{ bin: string; args: string[]; input: string }> } {
  const calls: Array<{ bin: string; args: string[]; input: string }> = [];
  let i = 0;
  const spawn: ClaudeCliSpawnFn = async (bin, args, input) => {
    calls.push({ bin, args, input });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
  return { spawn, calls };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(role: 'user' | 'assistant', content: string, ts = Date.now()): Message {
  return { role, content, ts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionCompactor', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;

  const agentId = 'test-agent';
  const chatId = '123456';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compactor-test-'));
    sessionStore = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // U18: compact with < 5 messages → throws NotEnoughMessagesError
  // -------------------------------------------------------------------------
  it('U18: compact with fewer than 5 messages throws NotEnoughMessagesError', async () => {
    const { spawn } = queueSpawn(makeSpawnSuccess('unused'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', 'msg 1'));
    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('assistant', 'reply 1'));
    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', 'msg 2'));

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow(NotEnoughMessagesError);

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('3 messages, minimum 5 required');
  });

  it('U18b: compact with exactly 4 messages throws NotEnoughMessagesError', async () => {
    const { spawn, calls } = queueSpawn(makeSpawnSuccess('unused'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 4; i++) {
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', `msg ${i}`));
    }

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toBeInstanceOf(NotEnoughMessagesError);

    // claude CLI should NOT have been called (error thrown before CLI call)
    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // U19: successful compact → archive saved at {sessionId}.pre-compact-{ts}.json
  // -------------------------------------------------------------------------
  it('U19: successful compact saves archive file named {sessionId}.pre-compact-{ts}.json', async () => {
    const { spawn } = queueSpawn(makeSpawnSuccess('This is a concise summary of the conversation.'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 6; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `message ${i}`));
    }

    const tsBefore = Date.now();
    await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
    const tsAfter = Date.now();

    const telegramDir = path.join(tmpDir, agentId, 'sessions', `telegram-${chatId}`);
    const archiveFiles = fs.readdirSync(telegramDir).filter(f => f.includes('.pre-compact-'));
    expect(archiveFiles).toHaveLength(1);

    const archiveFile = archiveFiles[0];
    expect(archiveFile).toMatch(new RegExp(`^${sessionId}\\.pre-compact-\\d+\\.json$`));

    const tsInFile = parseInt(archiveFile.replace(`${sessionId}.pre-compact-`, '').replace('.json', ''), 10);
    expect(tsInFile).toBeGreaterThanOrEqual(tsBefore);
    expect(tsInFile).toBeLessThanOrEqual(tsAfter);

    const archivePath = path.join(telegramDir, archiveFile);
    const archived = JSON.parse(fs.readFileSync(archivePath, 'utf-8')) as Message[];
    expect(archived).toHaveLength(6);
  });

  // -------------------------------------------------------------------------
  // U-CB1: the summary call honors CLAUDE_BIN (which may carry args), passes the
  // selected model, and includes --print. Prevents compaction from silently using
  // the CLI default model or a hardcoded bare `claude` binary.
  // -------------------------------------------------------------------------
  it('U-CB1: honors CLAUDE_BIN (with args) and passes --print with the selected model', async () => {
    const { spawn, calls } = queueSpawn(makeSpawnSuccess('summary'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;
    for (let i = 0; i < 6; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `m${i}`));
    }

    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = 'node /opt/claude/cli.js';
    try {
      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prev;
    }

    expect(calls[0].bin).toBe('node');
    expect(calls[0].args).toEqual(['/opt/claude/cli.js', '--print', '--model', 'claude-sonnet-4-6']);
  });

  // -------------------------------------------------------------------------
  // U-CB2: with CLAUDE_BIN unset the binary is resolved (non-empty), and the
  // selected model is still passed to the CLI.
  // -------------------------------------------------------------------------
  it('U-CB2: resolves a binary and passes --print when CLAUDE_BIN is unset', async () => {
    const { spawn, calls } = queueSpawn(makeSpawnSuccess('summary'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;
    for (let i = 0; i < 6; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `m${i}`));
    }

    const prev = process.env.CLAUDE_BIN;
    delete process.env.CLAUDE_BIN;
    try {
      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_BIN = prev;
    }

    expect(typeof calls[0].bin).toBe('string');
    expect(calls[0].bin.length).toBeGreaterThan(0);
    expect(calls[0].args).toEqual(['--print', '--model', 'claude-sonnet-4-6']);
  });

  // -------------------------------------------------------------------------
  // U20: compacted history has summary system message + last 40 verbatim
  // -------------------------------------------------------------------------
  it('U20: compacted history has summary system message as first entry plus last 40 verbatim messages', async () => {
    const { spawn } = queueSpawn(makeSpawnSuccess('Summary: user asked about 7 things, assistant answered.'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    // Populate with 7 messages (fewer than 40, so all are kept verbatim)
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `content of message ${i}`, Date.now() + i);
      messages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    const summaryText = 'Summary: user asked about 7 things, assistant answered.';

    await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

    const compacted = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);

    // 7 messages < 40, so all 7 kept + 1 summary = 8
    expect(compacted).toHaveLength(8);

    // First message is the system summary
    expect(compacted[0].role).toBe('system');
    expect(compacted[0].content).toContain('[Conversation Summary]');
    expect(compacted[0].content).toContain(summaryText);

    // All 7 original messages are verbatim
    for (let i = 0; i < 7; i++) {
      expect(compacted[i + 1].content).toBe(messages[i].content);
    }
  });

  it('U20b: compact returns correct CompactionResult metadata', async () => {
    const { spawn } = queueSpawn(makeSpawnSuccess('brief summary'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    // 5 messages of known content
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, '1234567890'));
    }

    const result = await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

    expect(result.beforeMessages).toBe(5);
    expect(result.afterMessages).toBe(6); // 1 summary + 5 verbatim (all < 40)
    expect(result.beforeTokens).toBeGreaterThan(0);
    expect(result.afterTokens).toBeGreaterThan(0);
    expect(result.reductionPct).toBeGreaterThanOrEqual(0);
    expect(result.contextPctBefore).toBeGreaterThanOrEqual(0);
    expect(result.contextPctAfter).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // U21: CLI failure mid-compact → original history unchanged
  // (single-chunk / non-chunked path: a failure is NOT retried/degraded — there is
  // nothing to fall back to, so the compact job still fails as before)
  // -------------------------------------------------------------------------
  it('U21: CLI failure mid-compact leaves original history unchanged', async () => {
    const { spawn } = queueSpawn(makeSpawnError(1, 'Internal error'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    const originalMessages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `original message ${i}`);
      originalMessages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('claude CLI exited with status 1');

    const afterFailure = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);
    expect(afterFailure).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(afterFailure[i].content).toBe(originalMessages[i].content);
      expect(afterFailure[i].role).toBe(originalMessages[i].role);
    }
  });

  it('U21b: CLI process error mid-compact leaves original history unchanged', async () => {
    // Simulate process spawn error (e.g., claude not found)
    const { spawn } = queueSpawn({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') });
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    const originalMessages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `message ${i}`);
      originalMessages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('claude CLI error: spawn ENOENT');

    const afterFailure = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);
    expect(afterFailure).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(afterFailure[i].content).toBe(originalMessages[i].content);
    }
  });

  it('U21c: CLI failure still saves the archive file before failing', async () => {
    // Archive write happens BEFORE the CLI call, so it should survive the failure
    const { spawn } = queueSpawn(makeSpawnError(1, 'Rate limited'));
    const compactor = new SessionCompactor(sessionStore, spawn);
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `msg ${i}`));
    }

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow();

    const telegramDir = path.join(tmpDir, agentId, 'sessions', `telegram-${chatId}`);
    const archiveFiles = fs.readdirSync(telegramDir).filter(f => f.includes('.pre-compact-'));
    expect(archiveFiles).toHaveLength(1);
  });

  // ─── API channel /compact against the flat store (#160) ──────────────────────
  //
  // For the api channel, the conversation lives in the flat sessions/{sessionId}.jsonl
  // store (appended by the api message path), NOT the structured telegram-style store.
  // Before the fix, compact() read the empty structured store and always failed with
  // "Not enough messages to compact (0 messages)". These exercise the end-to-end fix:
  // SessionStore api routing + SessionCompactor.
  describe('api channel (#160)', () => {
    // The runner passes storeChatId = chatId (raw, no prefix) — the store adds the channel
    // prefix internally. Using a raw chatId here matches real usage.
    const apiStoreChatId = '777000';
    const apiSessionId = 'sess-compact-1';

    it('U-CMP-API-1: regression — pre-fix the structured store is empty so /compact would see 0 messages', async () => {
      // Seed only the flat store, exactly as the api message path does.
      for (let i = 0; i < 6; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
        await sessionStore.appendMessage(agentId, apiSessionId, makeMsg(role, `api message ${i}`));
      }

      // The OLD (buggy) behaviour read the structured store with the telegram default channel.
      const structuredView = await sessionStore.loadTelegramSession(agentId, apiStoreChatId, apiSessionId /* telegram default */);
      expect(structuredView).toEqual([]); // empty → would throw NotEnoughMessagesError(0)

      // The fix: reading with the api channel surfaces the real conversation.
      const apiView = await sessionStore.loadTelegramSession(agentId, apiStoreChatId, apiSessionId, 'api');
      expect(apiView).toHaveLength(6);
    });

    it('U-CMP-API-2: compact(api) succeeds on a flat-store conversation and writes the result back to the flat store', async () => {
      const { spawn } = queueSpawn(makeSpawnSuccess('Concise api summary.'));
      const compactor = new SessionCompactor(sessionStore, spawn);

      const messages: Message[] = [];
      for (let i = 0; i < 6; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
        const msg = makeMsg(role, `api message ${i}`, Date.now() + i);
        messages.push(msg);
        await sessionStore.appendMessage(agentId, apiSessionId, msg);
      }

      const result = await compactor.compact(agentId, apiStoreChatId, apiSessionId, 'claude-sonnet-4-6', 200000, 'api');

      expect(result.beforeMessages).toBe(6);
      expect(result.afterMessages).toBe(7); // 1 summary + 6 verbatim (all < KEEP_LAST_MESSAGES)

      // The compacted result must land in the flat store — what buildInitialPrompt reloads at spawn.
      const flat = await sessionStore.loadSession(agentId, apiSessionId);
      expect(flat).toHaveLength(7);
      expect(flat[0].role).toBe('system');
      expect(flat[0].content).toContain('[Conversation Summary]');
      expect(flat[0].content).toContain('Concise api summary.');
      expect(flat[flat.length - 1].content).toBe('api message 5');
    });

    it('U-CMP-API-3: compact(api) archives the original under the structured api-{chatId} dir', async () => {
      const { spawn } = queueSpawn(makeSpawnSuccess('summary'));
      const compactor = new SessionCompactor(sessionStore, spawn);

      for (let i = 0; i < 6; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
        await sessionStore.appendMessage(agentId, apiSessionId, makeMsg(role, `api message ${i}`));
      }

      await compactor.compact(agentId, apiStoreChatId, apiSessionId, 'claude-sonnet-4-6', 200000, 'api');

      const apiDir = path.join(tmpDir, agentId, 'sessions', `api-${apiStoreChatId}`); // → sessions/api-777000
      const archives = fs.readdirSync(apiDir).filter(f => f.includes('.pre-compact-'));
      expect(archives).toHaveLength(1);
      const archived = JSON.parse(fs.readFileSync(path.join(apiDir, archives[0]), 'utf-8')) as Message[];
      expect(archived).toHaveLength(6);
    });

    it('U-CMP-API-4: compact(api) with fewer than 5 flat-store messages still throws NotEnoughMessagesError', async () => {
      const { spawn, calls } = queueSpawn(makeSpawnSuccess('unused'));
      const compactor = new SessionCompactor(sessionStore, spawn);

      await sessionStore.appendMessage(agentId, apiSessionId, makeMsg('user', 'one'));
      await sessionStore.appendMessage(agentId, apiSessionId, makeMsg('assistant', 'two'));

      await expect(
        compactor.compact(agentId, apiStoreChatId, apiSessionId, 'claude-sonnet-4-6', 200000, 'api'),
      ).rejects.toThrow(NotEnoughMessagesError);

      // CLI must never be invoked when there's nothing to compact.
      expect(calls).toHaveLength(0);
    });
  });

  // ─── Large-session chunked compaction (#376) — the async spawn + concurrency +
  //     per-chunk retry/degrade + progress-callback behavior this issue fixes ───
  describe('large-session chunking (#376)', () => {
    /** Build enough messages to exceed CHUNK_CHARS (100_000) after joining. */
    function seedLargeSession(sessionId: string, chunkCount: number): Promise<void> {
      // Each message ~30K chars of content → ~4 msgs ≈ 1 chunk boundary crossed;
      // use a generous multiplier so `chunkCount` chunks are produced reliably.
      const bigContent = 'x'.repeat(30_000);
      const totalMsgs = chunkCount * 4 + 2; // +2 margin beyond KEEP_LAST_MESSAGES tail exclusion isn't needed here since these are all "toSummarize"
      const writes: Promise<void>[] = [];
      for (let i = 0; i < totalMsgs; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
        writes.push(sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, bigContent, Date.now() + i)));
      }
      return Promise.all(writes).then(() => undefined);
    }

    it('U-CMP-LG-1: chunked compact makes multiple CLI calls (one per chunk + one merge)', async () => {
      const { spawn, calls } = queueSpawn(makeSpawnSuccess('chunk or merge summary'));
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      await seedLargeSession(sessionId, 3);

      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

      // Must be more than one call (chunked), and the last call is the merge.
      expect(calls.length).toBeGreaterThan(1);
    });

    it('U-CMP-LG-2: never runs more than CHUNK_CONCURRENCY (4) chunk-summary calls at once', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const spawn: ClaudeCliSpawnFn = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return makeSpawnSuccess('summary');
      };
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      await seedLargeSession(sessionId, 12); // well beyond the concurrency cap

      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes, not sequential
    });

    it('U-CMP-LG-3: one failing chunk degrades to a raw excerpt instead of failing the whole compact', async () => {
      let call = 0;
      const mergeInputs: string[] = [];
      const spawn: ClaudeCliSpawnFn = async (_bin, _args, input) => {
        call++;
        // Fail every call whose prompt is for "part 2" (both attempts), succeed on everything else.
        if (input.includes('part 2 of')) return makeSpawnError(1, 'model overloaded');
        if (input.includes('Merge them into a single concise summary')) mergeInputs.push(input);
        return makeSpawnSuccess(`ok-summary-${call}`);
      };
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      await seedLargeSession(sessionId, 3);

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Must NOT throw — the whole job completes despite the one dead chunk.
        const result = await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
        expect(result.afterMessages).toBeGreaterThan(0);

        // The degraded excerpt (not a thrown error) is what reached the merge step —
        // proves the bad chunk was carried forward as data, not allowed to kill the job.
        expect(mergeInputs).toHaveLength(1);
        expect(mergeInputs[0]).toContain('summarization failed after 2 attempts');

        // Degradation is logged server-side, not silent.
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Chunk 2/'));
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('summarization failed after 2 attempts'));
      } finally {
        errSpy.mockRestore();
      }
    });

    it('U-CMP-LG-4: merge-call failure degrades to the concatenated chunk summaries instead of throwing', async () => {
      const spawn: ClaudeCliSpawnFn = async (_bin, _args, input) => {
        // The merge call carries the "Merge them into a single concise summary" instruction.
        if (input.includes('Merge them into a single concise summary')) return makeSpawnError(1, 'merge model down');
        return makeSpawnSuccess('chunk-ok');
      };
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      await seedLargeSession(sessionId, 3);

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      let result: Awaited<ReturnType<typeof compactor.compact>>;
      try {
        result = await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Merge-summaries call failed after 2 attempts'));
      } finally {
        errSpy.mockRestore();
      }
      expect(result.afterMessages).toBeGreaterThan(0);

      const compacted = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);
      const summaryMsg = compacted.find((m) => m.role === 'system');
      // Degraded output is the concatenated per-part summaries (still contains the per-part markers).
      expect(summaryMsg?.content).toContain('[Part 1/');
      expect(summaryMsg?.content).toContain('chunk-ok');
    });

    it('U-CMP-LG-5: onProgress is called once per completed chunk, ending at (total, total)', async () => {
      const { spawn } = queueSpawn(makeSpawnSuccess('summary'));
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      await seedLargeSession(sessionId, 3);

      const progressCalls: Array<[number, number]> = [];
      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000, 'telegram', (done, total) => {
        progressCalls.push([done, total]);
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      const total = progressCalls[0][1];
      expect(progressCalls.every(([, t]) => t === total)).toBe(true);
      expect(progressCalls[progressCalls.length - 1]).toEqual([total, total]);
      // done values must be exactly 1..total, one call each (no skips, no dupes).
      expect(progressCalls.map(([d]) => d)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    });

    it('U-CMP-LG-6: onProgress is never called for a non-chunked (single-call) compact', async () => {
      const { spawn } = queueSpawn(makeSpawnSuccess('summary'));
      const compactor = new SessionCompactor(sessionStore, spawn);
      const index = await sessionStore.getOrCreateIndex(agentId, chatId);
      const sessionId = index.activeSessionId;
      for (let i = 0; i < 6; i++) {
        const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
        await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `small ${i}`));
      }

      const progressCalls: Array<[number, number]> = [];
      await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000, 'telegram', (done, total) => {
        progressCalls.push([done, total]);
      });

      expect(progressCalls).toHaveLength(0);
    });
  });
});
