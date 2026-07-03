#!/usr/bin/env node
/**
 * claude-pty-shell — runs the *interactive* Claude Code TUI inside a PTY
 * while speaking the gateway's headless stream-json protocol on stdio.
 *
 * Drop-in usage (no gateway code changes):
 *   CLAUDE_BIN="node /path/to/dist/shell/claude-pty-shell.js"
 *
 * Design: planning-60-pty-shell-wrapper.md. Text source of truth is the
 * session transcript JSONL (streamed mid-turn = message-level streaming);
 * the PTY screen is used only for busy/idle/dialog liveness signals.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as readline from 'readline';
import { translateArgs, sanitizeUserText } from './args';
import { ScreenModel, MenuOption, parseMenuChoice, formatMenuPrompt, formatPermissionPrompt, extractChannelContent, isPtyActivelyWorking, parseInteractivePrompt } from './screen';
import { PtyHost } from './pty-host';
import { TranscriptTailer, AssistantRecord, UsageInfo } from './tailer';
import { ProtocolEmitter } from './emitter';
import { preTrustWorkspace, checkAuthStatus } from './trust';
import { decideMenuCancel } from './menu-cancel';
import { decideProbeAttempt, confirmProbeReaction, ProbeState, PROBE_KEY_DOWN, PROBE_KEY_UP, PROBE_SETTLE_MS } from './menu-probe';

const POLL_MS = 200;
const STARTUP_QUIET_MS = 600;
// How often to touch the heartbeat file during an active turn (PTY mode keepalive).
// Must be well under the receiver's STALLED_TIMEOUT_MS (300s) to prevent false warnings.
const HEARTBEAT_INTERVAL_MS = 60_000;
// Liveness window for the heartbeat: if the PTY produced output more recently than
// this (and we're not parked at an idle prompt), Claude is considered actively
// working even when the exact "esc to interrupt" busy marker isn't on screen.
// Covers states where isBusy() goes false but work continues — context compaction,
// large request assembly, and long sub-agent tasks whose spinner keeps animating
// (ticking the elapsed-time counter) and so keeps emitting PTY bytes. Sized well
// above the ~1s spinner tick and below the 60s beat interval, so a genuinely hung
// or idle TUI (no output) still goes quiet → no beat → stalled detector fires.
const HEARTBEAT_LIVENESS_QUIET_MS = 45_000;
const SUBMIT_ENTER_DELAY_MS = 300;
const SUBMIT_RETRY_AFTER_MS = 4000;
const MAX_ENTER_RETRIES = 2;
const FALLBACK_IDLE_QUIET_MS = 2000;
const DIALOG_ACTION_COOLDOWN_MS = 2000;
// An interactive select menu must be stable (no PTY output) this long before we
// bridge it to chat — avoids racing a menu that's still rendering.
const MENU_STABLE_QUIET_MS = 700;
// After injecting the digit for a menu choice, wait this long, then send Enter
// only if the menu is still on screen (some TUIs confirm on the digit alone).
const MENU_SELECT_ENTER_DELAY_MS = 250;
// Set PTY_SHELL_SKIP_MENU_BRIDGE=1 to disable bridging interactive menus to chat
// (falls back to leaving the menu on the PTY — use if a TUI update breaks the matcher).
const SKIP_MENU_BRIDGE = process.env.PTY_SHELL_SKIP_MENU_BRIDGE === '1';
const STARTUP_TIMEOUT_MS = 120_000;
const WATCHDOG_MS = process.env.PTY_SHELL_WATCHDOG_MS
  ? Number(process.env.PTY_SHELL_WATCHDOG_MS) || (30 * 60 * 1000)
  : 30 * 60 * 1000;
// Set PTY_SHELL_SKIP_DIALOG_DISMISS=1 to disable all TUI dialog auto-dismiss.
// Use when a new Claude Code version changes TUI text and dialog patterns break.
const SKIP_DIALOG_DISMISS = process.env.PTY_SHELL_SKIP_DIALOG_DISMISS === '1';

// Set PTY_SHELL_NO_BRACKETED_PASTE=1 if the Claude Code TUI ever disables bracketed
// paste mode. Without bracketed paste, a newline inside the user's message would
// submit the input early. sanitizeUserText() strips CR so the '\r' sent after the
// text is the only submit trigger — safe in both modes.
const NO_BRACKETED_PASTE = process.env.PTY_SHELL_NO_BRACKETED_PASTE === '1';

const DEBUG = process.env.PTY_SHELL_DEBUG === '1';

function logError(msg: string): void {
  process.stderr.write(`[pty-shell] ERROR ${msg}\n`);
}
function logWarn(msg: string): void {
  process.stderr.write(`[pty-shell] WARN ${msg}\n`);
}
function logDebug(msg: string): void {
  if (DEBUG) process.stderr.write(`[pty-shell] DEBUG ${msg}\n`);
}

interface ActiveTurn {
  startedAt: number;
  submittedAt: number;
  enterRetries: number;
  sawBusy: boolean;
  sawAssistant: boolean;
  lastProgressAt: number;
  texts: string[];
  usage: UsageInfo | null;
  dialogEscapes: number;
  /** Snapshot of tailer.seenRecords at turn start — used to detect per-turn output. */
  recordsAtStart: number;
  /** True when this turn was begun by a menu selection (handleMenuReply) — the
   *  only turn type where a live menu can legitimately still be on screen
   *  before any busy/record signal this turn (the digit was swallowed with the
   *  menu still up, or a multi-question wizard advanced to its next step
   *  without the tool_use returning). Gates probe eligibility and the
   *  Enter-retry's menu suppression (review round 2, findings 1+4). */
  fromMenuSelection: boolean;
  /** Behavioral-probe round budget for this turn's current stall, or null
   *  before the first probe round. Replaces the old transcript-gated
   *  menuToolSeen — see maybeProbeAndBridge()/advanceProbe() below and
   *  planning-61. */
  probe: ProbeState | null;
  /** tool_use ids from this turn's own (non-sidechain) assistant records that
   *  have no matching tool_result yet. A Task tool call runs an invisible
   *  sub-agent whose own work writes only sidechain transcript records — the
   *  screen can look idle (no busy marker, quiet ≥ FALLBACK_IDLE_QUIET_MS)
   *  for stretches while it's genuinely still running. Non-empty blocks the
   *  fallback end-of-turn heuristic so it can never end the turn out from
   *  under a pending tool call. */
  pendingToolUseIds: Set<string>;
}

/** An in-flight behavioral probe round, advanced by tick() (see Driver.probe). */
interface ProbeRound {
  /** The turn that owns this round — abandoned when the turn ends. */
  turn: ActiveTurn;
  /** 'sent-down' after the Down keystroke; 'sent-up' after the Up fallback. */
  phase: 'sent-down' | 'sent-up';
  /** When the current phase's keystroke was written (settle timing). */
  sentAt: number;
  /** Full screen snapshot taken immediately before the Down keystroke. */
  before: string;
}

class Driver {
  private ready = false;
  private exiting = false;
  private startedAt = Date.now();
  private queue: string[] = [];
  private turn: ActiveTurn | null = null;
  // Set when an interactive menu has been bridged to chat and we're awaiting the
  // user's choice. While set, the next stdin message is treated as a selection.
  private pendingMenu: { options: MenuOption[] } | null = null;
  // Set after ESC-cancelling a bridged menu in response to a free-text reply.
  // The queued text is held until the TUI settles back to an idle prompt (driven
  // by tick()), so the paste doesn't race Claude's cancellation redraw.
  private menuCancel: { since: number; lastEscAt: number; escs: number } | null = null;
  // Set after a /stop (SIGINT → ESC) interrupted the active turn. An interrupted
  // turn writes no turn_duration record, so tick() ends it once the TUI is back to
  // an idle prompt — otherwise a message queued right after /stop would hang behind
  // a turn that never ends (until the watchdog). Reuses the menu-cancel settle
  // decision (menuVisible is always false here, so it never re-sends ESC).
  private interrupting: { since: number; lastEscAt: number; escs: number } | null = null;
  // True once session_idle has been emitted for the current idle stretch. Reset on
  // any new activity (turn start / assistant record). Drives the screen-driven idle
  // reconciliation in tick() so typing is always torn down even when finishTurn()
  // never ran (turn-tracking desync, external stop) — fires exactly once per idle.
  private idleNotified = false;
  // Guards the recoverable "Request too large (max 32MB)" handler so ESC isn't
  // re-sent every poll while the error overlay lingers. Reset when a new turn begins.
  private requestTooLargeHandled = false;
  private lastDialogActionAt = 0;
  // In-flight behavioral probe round, advanced synchronously by tick() at a
  // single chokepoint — the same tick-driven pattern as menuCancel and
  // interrupting (review round 2, finding 6; replaced a detached async
  // coroutine whose racing with tick() needed scattered mutual-exclusion
  // guards). While set, tick() returns early, so no other keystroke path
  // (dialog auto-accept, Enter-retry, fallback-idle) can interleave with the
  // round's arrows, and every non-confirmed exit funnels through
  // finishProbeRound() so an Up-recall is always restored.
  private probe: ProbeRound | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private host!: PtyHost;
  private tailer!: TranscriptTailer;
  private streamSocket: net.Socket | null = null;

  private readonly screen = new ScreenModel();
  private readonly emitter = new ProtocolEmitter();
  private readonly args = translateArgs(process.argv.slice(2));
  // CLAUDE_REAL_BIN may be multi-word (e.g. "node /path/cli.js"), same as CLAUDE_BIN.
  private readonly realBinParts = (process.env.CLAUDE_REAL_BIN ?? 'claude').split(' ');

  start(): void {
    // Fail fast if Claude is not authenticated — avoids getting stuck on a login dialog.
    const claudeBin = this.realBinParts[0];
    const auth = checkAuthStatus(claudeBin);
    if (!auth.loggedIn) {
      logError('Claude is not authenticated. Run `claude login` on the server before starting the gateway.');
      this.emitter.emitResult({
        sessionId: this.args.sessionId, isError: true,
        text: 'Claude is not authenticated. Please run `claude login` on the server.',
        durationMs: 0, usage: null,
      });
      process.exit(1);
    }
    // Pre-trust the workspace so the trust-folder dialog never appears.
    preTrustWorkspace(process.cwd());

    const [realBin, ...realBinArgs] = this.realBinParts;
    logDebug(`session=${this.args.sessionId} bin=${this.realBinParts.join(' ')} args=${this.args.claudeArgs.join(' ')}`);

    const streamSocketPath = process.env.PTY_SHELL_STREAM_SOCKET;
    if (streamSocketPath) {
      const sock = net.createConnection(streamSocketPath);
      sock.on('error', (err) => {
        // Non-fatal: the registry socket may not be ready yet or was already closed.
        // Log so timing issues are diagnosable without a restart.
        logWarn(`stream socket error (${streamSocketPath}): ${err.message}`);
      });
      this.streamSocket = sock;
    }

    this.host = new PtyHost(realBin, [...realBinArgs, ...this.args.claudeArgs], {
      cols: this.screen.cols,
      rows: this.screen.rows,
      cwd: process.cwd(),
      onData: (d) => {
        this.screen.write(d);
        if (this.streamSocket?.writable) {
          // node-pty emits UTF-8-decoded strings, so re-encode as UTF-8 to keep
          // multi-byte glyphs (box-drawing ─│╭╮, the braille spinner, emoji)
          // intact. Writing as latin1 would truncate every code point > 0xFF to
          // a single byte — those land in the 0x00-0x1F control range and
          // scramble the viewer's cursor positioning. The client decodes the
          // stream with TextDecoder('utf-8'), so this is the matching encoding.
          try { this.streamSocket.write(d, 'utf8'); } catch { /* socket closed */ }
        }
      },
      onExit: (code) => this.onChildExit(code),
    });

    this.tailer = new TranscriptTailer(process.cwd(), this.args.sessionId, {
      onAssistant: (record) => this.onAssistant(record),
      onTurnEnd: (durationMs) => this.onTurnEnd(durationMs),
      onRequestTooLarge: () => this.handleRequestTooLarge(),
      onToolResult: (toolUseId) => this.onToolResult(toolUseId),
      onError: (err) => logError(`tailer: ${err.message}`),
    });
    this.tailer.start();

    this.attachStdin();
    this.attachSignals();
    this.tickTimer = setInterval(() => this.tick(), POLL_MS);
  }

  // ---- stdin: gateway → wrapper -------------------------------------------

  private attachStdin(): void {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        logWarn(`ignoring non-JSON stdin line (${line.length} bytes)`);
        return;
      }
      if (obj.type !== 'user') {
        logDebug(`ignoring stdin message type=${String(obj.type)}`);
        return;
      }
      const message = obj.message as { content?: unknown } | undefined;
      let text = '';
      if (typeof message?.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message?.content)) {
        text = (message.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n');
      }
      const sanitized = sanitizeUserText(text);
      if (!sanitized.trim()) {
        logWarn('user turn empty after sanitization — answering with error result');
        this.emitter.emitResult({
          sessionId: this.args.sessionId, isError: true,
          text: 'empty user message', durationMs: 0, usage: null,
        });
        return;
      }
      // A menu is awaiting a choice — interpret this message as the selection
      // (a typed number or a button tap, which both arrive as plain text).
      if (this.pendingMenu) {
        this.handleMenuReply(sanitized);
        return;
      }
      this.queue.push(sanitized);
      this.trySubmit();
    });
    rl.on('close', () => {
      // Gateway is gone; no point running a TUI for nobody.
      logWarn('stdin closed — shutting down');
      this.shutdown(0);
    });
  }

  private attachSignals(): void {
    // Gateway interrupt() sends SIGINT → translate to ESC (interrupts the TUI turn).
    process.on('SIGINT', () => {
      if (this.turn) {
        logWarn('SIGINT → sending ESC to interrupt current turn');
        this.host.writeRaw('\x1b');
        // Arm interrupt-settle so tick() ends the (now interrupted) turn once the
        // TUI returns to an idle prompt, then drains anything queued after /stop.
        // No-op if already armed (repeated SIGINTs during the same interrupt).
        if (!this.interrupting) {
          const t = Date.now();
          this.interrupting = { since: t, lastEscAt: t, escs: 1 };
        }
      } else if (this.queue.length > 0) {
        // No active turn: the message is still in the queue (not yet pasted into
        // the PTY input). Drop it so /stop doesn't silently submit it later.
        logWarn(`SIGINT with no active turn — dropping ${this.queue.length} queued message(s)`);
        this.queue.length = 0;
      }
    });
    process.on('SIGTERM', () => {
      logDebug('SIGTERM → killing claude');
      this.shutdown(0);
    });
  }

  // ---- transcript events: claude → gateway --------------------------------

  private onAssistant(record: AssistantRecord): void {
    const usage = record.message.usage;
    if (usage) this.emitter.emitMessageStartShim(usage, this.args.sessionId);
    const text = this.emitter.emitAssistant(record, this.args.sessionId);
    // New output = activity: re-arm idle reconciliation so a fresh session_idle is
    // emitted once Claude settles, even if this record arrived outside a tracked turn.
    this.idleNotified = false;
    if (this.turn) {
      this.turn.sawAssistant = true;
      this.turn.lastProgressAt = Date.now();
      if (text) this.turn.texts.push(text);
      if (usage) this.turn.usage = usage;
      for (const block of record.message.content) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.turn.pendingToolUseIds.add(block.id);
        }
      }
    } else {
      logDebug('assistant record outside an active turn (emitted anyway)');
    }
  }

  /** A non-sidechain tool_result landed — clears the pending Task/tool gate
   *  on the fallback end-of-turn heuristic (see ActiveTurn.pendingToolUseIds). */
  private onToolResult(toolUseId: string): void {
    if (this.turn) this.turn.pendingToolUseIds.delete(toolUseId);
  }

  private onTurnEnd(durationMs: number): void {
    logDebug(`turn_duration record (${durationMs}ms)`);
    if (this.turn) this.finishTurn(false);
  }

  /**
   * Authoritative recovery for the recoverable 32MB "Request too large" error.
   * Fired by the transcript tailer when Claude Code writes its `<synthetic>`
   * error record (NOT by scraping screen text — quoted/re-injected prose can't
   * forge that record, so this never false-fires). The TUI is showing the
   * "Double press esc to go back" overlay; dismiss it with ESC so the input
   * prompt is usable again, then signal the gateway to notify the user and
   * restart with a fresh context. Once per occurrence via requestTooLargeHandled
   * (reset when a new turn begins).
   *
   * No screen-settle gate is needed here (the old screen-scrape path waited for
   * quietMs to avoid transient redraws): the transcript record is only written
   * when the error is real and the overlay rendered, so the signal is already
   * settled by the time the tailer reads it. A stray ESC at a non-overlay prompt
   * is harmless, and the guard prevents repeats.
   */
  private handleRequestTooLarge(): void {
    if (this.requestTooLargeHandled) return;
    this.requestTooLargeHandled = true;
    logWarn('Request too large (32MB) — synthetic-error record in transcript; dismissing overlay and signalling restart');
    this.host.writeRaw('\x1b'); // "Double press esc to go back" — send both.
    this.host.writeRaw('\x1b');
    this.emitter.emitRequestTooLarge(this.args.sessionId);
    if (this.turn) {
      this.finishTurn(true, 'Request too large (max 32MB) — the conversation exceeded Anthropic\'s 32MB request limit. Restarting with a fresh context.');
    }
  }

  private finishTurn(isError: boolean, errMsg?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    // Clear any armed interrupt-settle — the turn is ending now regardless of how
    // (interrupt path, normal turn_duration, or error), so a stale flag must not
    // linger and block the next trySubmit().
    this.interrupting = null;
    this.tailer.flush(); // drain any records written in the last poll window
    const text = turn.texts.join('');
    this.emitter.emitResult({
      sessionId: this.args.sessionId,
      isError,
      text: isError ? (errMsg ?? text ?? 'unknown error') : text,
      durationMs: Date.now() - turn.startedAt,
      usage: turn.usage,
    });
    if (isError) logError(`turn failed: ${errMsg ?? '(no detail)'}`);
    this.trySubmit();
    // If no new turn started and the queue is empty, the session is truly idle.
    // Emit session_idle so runner.ts can stop the typing indicator cleanly,
    // without relying on the short per-result timer that fires during tool-call gaps.
    if (!this.turn && this.queue.length === 0) {
      this.idleNotified = true;
      this.emitter.emitSessionIdle(this.args.sessionId);
    }
  }

  // ---- turn submission -----------------------------------------------------

  private trySubmit(): void {
    // While menuCancel is armed, submission is deferred to tick() until the TUI
    // settles after an ESC menu-cancel — don't let an event-driven trySubmit
    // (e.g. a second incoming message) paste into the cancellation transition.
    if (!this.ready || this.turn || this.queue.length === 0 || this.exiting || this.menuCancel || this.interrupting) return;
    const text = this.queue.shift() as string;
    this.beginTurn();
    void this.typeAndSubmit(text);
  }

  /** Initialize a fresh active turn (shared by normal submit and menu selection). */
  private beginTurn(fromMenuSelection = false): void {
    const now = Date.now();
    this.idleNotified = false;
    this.requestTooLargeHandled = false;
    this.turn = {
      startedAt: now,
      submittedAt: 0,
      enterRetries: 0,
      sawBusy: false,
      sawAssistant: false,
      lastProgressAt: now,
      texts: [],
      usage: null,
      dialogEscapes: 0,
      recordsAtStart: this.tailer.seenRecords,
      fromMenuSelection,
      probe: null,
      pendingToolUseIds: new Set(),
    };
  }

  private async typeAndSubmit(text: string): Promise<void> {
    // Pre-paste guard: if SIGINT already fired between beginTurn() and here, skip the
    // paste entirely — no text lands in the PTY input so no clearing is needed.
    if (this.interrupting || !this.turn) {
      this.queue.length = 0;
      return;
    }
    // Clear any stale text sitting in the input line first — e.g. history the
    // probe's Up fallback recalled that an abandoned round couldn't restore —
    // so it is never prepended to this message (review round 2, finding 3).
    // A no-op at an empty idle prompt.
    this.host.writeRaw('\x15');
    if (NO_BRACKETED_PASTE) {
      // Fallback: sanitizeUserText() strips all CR, so '\r' below is the only
      // submit trigger — safe for multiline text without bracketed paste.
      await this.host.writeChunked(text);
    } else {
      // Bracketed paste prevents early submission on newlines inside the text.
      // \r must be a separate delayed write or the TUI treats it as part of the paste.
      await this.host.writeChunked(`\x1b[200~${text}\x1b[201~`);
    }
    await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
    // If interrupted while waiting (SIGINT arrived after paste but before Enter),
    // clear the PTY input line instead of submitting — prevents stuck text in the
    // prompt that would be prepended to the user's next message.
    // Also clear the queue so any messages queued behind this one don't surface
    // after the turn is abandoned (matches the SIGINT queue-drop logic above).
    if (this.abortIfInterrupted()) return;
    this.host.writeRaw('\r');
    if (this.turn) this.turn.submittedAt = Date.now();
  }

  // Sends Ctrl+U to clear the PTY input line, drains the queue, and returns true.
  // Call after writing to the PTY when an interrupt may have arrived mid-write.
  private abortIfInterrupted(): boolean {
    if (!this.interrupting && this.turn) return false;
    this.host.writeRaw('\x15'); // Ctrl+U: clear input line
    this.queue.length = 0;
    return true;
  }

  // ---- periodic liveness poll ----------------------------------------------

  private lastDumpAt = 0;
  private lastHeartbeatAt = 0;
  // Path to the receiver's heartbeat file (set via PTY_SHELL_HEARTBEAT_PATH env var).
  // Written periodically during active turns so the stalled detector doesn't fire
  // on long sub-agent tasks where the PTY is busy but no transcript lines are emitted.
  private readonly heartbeatPath = process.env.PTY_SHELL_HEARTBEAT_PATH ?? null;

  private tick(): void {
    if (this.exiting) return;
    const now = Date.now();

    if (DEBUG && now - this.lastDumpAt > 2000) {
      this.lastDumpAt = now;
      const txt = this.screen.text();
      logDebug(`state ready=${this.ready} turn=${!!this.turn} quiet=${this.screen.quietMs()}ms busy=${this.screen.isBusy()} prompt=${this.screen.hasPrompt()} screenlen=${txt.replace(/\s/g, '').length}`);
    }

    if (!this.ready) {
      if (this.screen.hasPrompt() && !this.screen.isBusy() && this.screen.quietMs() >= STARTUP_QUIET_MS) {
        this.ready = true;
        logDebug('TUI ready');
        this.emitter.emitInit(this.args.sessionId, this.args.model, process.cwd());
        this.trySubmit();
        return;
      }
      this.maybeHandleDialog();
      if (now - this.startedAt > STARTUP_TIMEOUT_MS) {
        logError(`claude TUI did not become ready within startup timeout; screen:\n${this.screen.text()}`);
        this.shutdown(1);
      }
      return;
    }

    // Heartbeat follows PTY liveness, NOT turn tracking. During a long request
    // assembly (the TUI shows "Baked for 6m…"), context compaction, a long
    // sub-agent task, an interrupt/menu-cancel settle, or a turn-tracking desync,
    // `this.turn` may be null or unsubmitted while Claude is genuinely working.
    // isPtyActivelyWorking() treats the session as alive when the busy spinner is
    // on screen OR the PTY emitted output recently — keeping the receiver's 5-min
    // stalled detector from false-firing mid-work.
    const ptyAlive = isPtyActivelyWorking(
      { isBusy: this.screen.isBusy(), quietMs: this.screen.quietMs() },
      HEARTBEAT_LIVENESS_QUIET_MS,
    );
    if (this.heartbeatPath
        && ptyAlive
        && now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeatAt = now;
      try { fs.writeFileSync(this.heartbeatPath, String(now)); } catch {}
    }

    // Screen-driven idle reconciliation (typing-teardown safety net). If the TUI
    // is sitting at a quiet idle prompt with no pending work, the session is idle —
    // emit session_idle so runner.ts tears down the typing indicator. This covers
    // turn-tracking desyncs where finishTurn() ended `this.turn` early (or never
    // ran) while Claude kept working: without it the typing bubble + tool-call
    // status stick forever. Fires once per idle stretch via the idleNotified guard.
    if (!this.idleNotified
        && !this.turn && !this.interrupting && !this.menuCancel && !this.pendingMenu
        && this.queue.length === 0
        && this.screen.hasPrompt() && !this.screen.isBusy()
        && this.screen.quietMs() >= FALLBACK_IDLE_QUIET_MS) {
      logDebug('screen idle with no pending work — emitting session_idle (reconciliation)');
      this.idleNotified = true;
      this.emitter.emitSessionIdle(this.args.sessionId);
    }

    // In-flight behavioral probe round: advance it at this single chokepoint
    // and do nothing else this tick — the dialog auto-accept '2', menu-cancel
    // ESCs, and the Enter-retry / fallback-idle keystrokes below must never
    // interleave with the round's arrows. advanceProbe() itself abandons the
    // round (restoring any Up-recall) when the owning turn is gone or an
    // interrupt is settling, so the blocks below run one tick later at most.
    if (this.probe) {
      this.advanceProbe(now);
      return;
    }

    // Waiting for the TUI to settle after ESC-cancelling a bridged menu (the user
    // typed a free-text reply instead of a number). Submit the queued prompt only
    // once the menu is gone and the prompt is idle — otherwise the paste races
    // Claude's cancellation redraw and never lands (→ watchdog hang).
    if (this.menuCancel) {
      const action = decideMenuCancel(this.menuCancel, {
        now,
        menuVisible: this.screen.interactivePromptBlocking(),
        hasPrompt: this.screen.hasPrompt(),
        isBusy: this.screen.isBusy(),
        quietMs: this.screen.quietMs(),
      });
      if (action === 'submit') {
        logDebug('menu cancelled and TUI settled — submitting queued prompt');
        this.menuCancel = null;
        this.trySubmit();
      } else if (action === 'resend-esc') {
        this.menuCancel.escs++;
        this.menuCancel.lastEscAt = now;
        logWarn(`menu still on screen after cancel — re-sending ESC (${this.menuCancel.escs}/3)`);
        this.host.writeRaw('\x1b');
      }
      return;
    }

    // Settling after a /stop interrupt (SIGINT → ESC). The interrupted turn is
    // still active (Claude writes no turn_duration for an interrupted turn), so
    // end it as soon as the TUI is back to a quiet idle prompt — finishTurn()
    // emits the result (clearing the gateway's in-flight state) and trySubmit()
    // drains anything the user queued after /stop. Without this, a turn interrupted
    // before any assistant output never meets the fallback below and the next
    // message hangs behind it until the watchdog. menuVisible is false here, so the
    // shared decision never returns 'resend-esc' — only 'wait' or (settle/timeout)
    // 'submit'.
    if (this.interrupting) {
      const action = decideMenuCancel(this.interrupting, {
        now,
        menuVisible: false,
        hasPrompt: this.screen.hasPrompt(),
        isBusy: this.screen.isBusy(),
        quietMs: this.screen.quietMs(),
      });
      if (action === 'submit') {
        logDebug('interrupt settled — ending interrupted turn');
        this.interrupting = null;
        this.finishTurn(false);
      }
      return;
    }

    const turn = this.turn;
    if (!turn || turn.submittedAt === 0) return;

    // (Heartbeat is written above, gated on the busy spinner — covers this active
    // turn as well as settle/desync states where `this.turn` is null.)

    if (this.screen.consumeBusySeen() || this.screen.isBusy()) {
      turn.sawBusy = true;
      turn.lastProgressAt = now;
      // Real activity resumed — a probe that ran out of rounds during this
      // stall gets a fresh budget if the turn genuinely stalls again later.
      // (A round can't be in flight here: tick() already returned at the
      // probe chokepoint above while one is outstanding.)
      if (turn.probe) turn.probe.rounds = 0;
      return;
    }

    // Not busy. Possible: still rendering, swallowed Enter, dialog, menu, or done
    // (turn_duration normally ends the turn before we get here).
    this.maybeHandleDialog();

    // Blocked on a live interactive overlay (AskUserQuestion menu, plan
    // approval, or a tool-permission Yes/No prompt) → probe behaviorally and
    // bridge it to chat if confirmed, so the session goes idle (no watchdog
    // kill) until the user picks an option. Starts a round at most; the
    // chokepoint above advances it on subsequent ticks and bridges on
    // confirmation.
    this.maybeProbeAndBridge(turn, now);
    if (this.probe) return; // a round just started — let it settle

    if (!turn.sawBusy
        && now - turn.submittedAt > SUBMIT_RETRY_AFTER_MS
        && this.screen.hasPrompt()
        && !(turn.fromMenuSelection && this.screen.interactivePromptBlocking())
        && this.screen.quietMs() > 1500
        && this.tailer.seenRecords === turn.recordsAtStart) {
      // Only retry if no new records have appeared since this turn started —
      // a delta > 0 means claude already started writing output.
      //
      // The interactivePromptBlocking() suppression applies ONLY to a
      // menu-selection turn: there a live menu genuinely can still be on
      // screen with no busy/record signal (the digit was swallowed, or a
      // multi-question wizard advanced), and a blind Enter would select
      // whatever row is highlighted — the probe re-bridges that state
      // instead. For an ordinary turn in this branch a menu is impossible
      // (Claude produced no output yet — same reasoning as the probe gate in
      // maybeProbeAndBridge()), so the retry must NOT be gated on screen
      // text: the unsubmitted draft itself renders as "❯ <text>" and, when
      // its text starts with "N.", satisfies the caret scan — suppressing
      // the exact retry this state needs and wedging the turn into the
      // 30-min watchdog (review round 2, finding 1).
      if (turn.enterRetries < MAX_ENTER_RETRIES) {
        turn.enterRetries++;
        turn.submittedAt = now;
        logWarn(`Enter appears swallowed — retry ${turn.enterRetries}/${MAX_ENTER_RETRIES}`);
        this.host.writeRaw('\r');
      } else {
        this.finishTurn(true, 'failed to submit turn to the TUI input');
      }
      return;
    }

    // Fallback end-of-turn (e.g. interrupted turn never writes turn_duration):
    // ran → idle prompt → quiet, and we already streamed assistant output.
    // pendingToolUseIds must be empty too — a Task tool call's sub-agent runs
    // invisibly (its own transcript records are sidechain and filtered out),
    // so the screen can look idle-quiet for stretches while the turn is
    // genuinely still in flight (see onToolResult()/pendingToolUseIds above).
    if (turn.sawBusy && turn.sawAssistant
        && turn.pendingToolUseIds.size === 0
        && this.screen.hasPrompt()
        && this.screen.quietMs() >= FALLBACK_IDLE_QUIET_MS) {
      logDebug('fallback idle detection ended the turn');
      this.finishTurn(false);
      return;
    }

    if (now - turn.lastProgressAt > WATCHDOG_MS) {
      this.finishTurn(true, `no progress for ${WATCHDOG_MS}ms — giving up`);
      this.shutdown(1);
    }
  }

  private maybeHandleDialog(): void {
    if (SKIP_DIALOG_DISMISS) return;
    const now = Date.now();
    if (now - this.lastDialogActionAt < DIALOG_ACTION_COOLDOWN_MS) return;
    if (this.screen.quietMs() < 500) return;
    const dialog = this.screen.detectDialog();
    if (!dialog) return;
    this.lastDialogActionAt = now;

    if (dialog === 'bypass-permissions') {
      // --dangerously-skip-permissions is built into the wrapper, so the
      // confirmation dialog is always accepted on the operator's behalf.
      logWarn('accepting Bypass Permissions dialog (per built-in --dangerously-skip-permissions)');
      this.host.writeRaw('2');
    }
  }

  // ---- interactive-prompt behavioral probe --------------------------------

  /**
   * Behavioral gate replacing the old screen-regex detectors + transcript
   * menuToolSeen gate (planning-61). While the turn looks stalled (settled
   * quiet, not busy, not already mid-selection), spend one probe round: send
   * an arrow keystroke and check whether the screen actually reacts. Rounds
   * are budgeted (PROBE_MAX_ROUNDS) and cooldown-spaced (decideProbeAttempt())
   * so a genuinely non-menu stall falls through to the existing Enter-retry /
   * fallback-idle-detection / watchdog path exactly as it does today.
   *
   * Starts the round only — tick()'s chokepoint drives it forward via
   * advanceProbe(), which ends the turn itself (via bridgeChoiceToChat())
   * only if the round confirms a live overlay.
   */
  private maybeProbeAndBridge(turn: ActiveTurn, now: number): void {
    if (SKIP_MENU_BRIDGE || this.pendingMenu) return;
    // An interactive overlay can only exist once Claude produced output this
    // turn — AskUserQuestion and the permission prompt both require a running
    // turn, so the busy spinner or a transcript record precedes them — or
    // when this turn IS a menu selection (see ActiveTurn.fromMenuSelection).
    // Before that, a quiet stall is a submission problem (swallowed Enter),
    // and probing it would type arrows into the user's unsubmitted draft —
    // the Up could replace the draft with recalled history that the later
    // Enter-retry then submits (review round 2, finding 4).
    if (!turn.sawBusy && !turn.fromMenuSelection
        && this.tailer.seenRecords === turn.recordsAtStart) return;
    if (this.screen.quietMs() < MENU_STABLE_QUIET_MS) return;
    const probe = (turn.probe ??= { lastAttemptAt: 0, rounds: 0 });
    if (decideProbeAttempt(probe, { now }) !== 'send') return;
    if (this.screen.detectDialog() === 'bypass-permissions') return;
    probe.lastAttemptAt = now;
    probe.rounds++;
    this.probe = { turn, phase: 'sent-down', sentAt: now, before: this.screen.text() };
    this.host.writeRaw(PROBE_KEY_DOWN);
  }

  /**
   * Advance the in-flight probe round by one tick (called only from tick()'s
   * chokepoint while `this.probe` is set). One round: send Down, settle,
   * check for a screen change; if Down produced nothing, retry once with Up
   * (covers the "already at the last option, no wraparound" boundary case).
   * A change alone is NOT enough to bridge: the before/after snapshots must
   * both parse as the same-shaped prompt whose ❯-highlighted row MOVED
   * (confirmProbeReaction() — the plan's point-2 comparison). Anything else
   * — unparseable, menu-shaped text whose caret didn't move, work resuming
   * mid-round, the turn ending, an interrupt settling — funnels through
   * finishProbeRound(), which restores any Up-recall (fail-safe: no bridge
   * rather than a fabricated one, and never stale text left in the input).
   *
   * The settle wait is tick-quantized: with POLL_MS === PROBE_SETTLE_MS the
   * effective settle is one to two poll intervals, which is fine — the outer
   * MENU_STABLE_QUIET_MS gate already guarantees the screen was stable when
   * the round started.
   */
  private advanceProbe(now: number): void {
    const p = this.probe as ProbeRound;
    // Owner turn gone (turn_duration landed mid-round) or a /stop interrupt
    // is settling — abandon before typing anything further.
    if (this.turn !== p.turn || this.interrupting) {
      this.finishProbeRound(p, 'turn ended or interrupt in flight');
      return;
    }
    if (now - p.sentAt < PROBE_SETTLE_MS) return; // still settling
    if (this.screen.isBusy()) {
      // Real work resumed mid-round (a reply started streaming) — the screen
      // is changing for its own reasons, not reacting to our keystroke.
      this.finishProbeRound(p, 'work resumed');
      return;
    }
    const after = this.screen.text();
    if (after === p.before) {
      if (p.phase === 'sent-down') {
        // Down produced nothing — maybe the highlight is already on the last
        // option (no wraparound). Fall back to Up once.
        p.phase = 'sent-up';
        p.sentAt = now;
        this.host.writeRaw(PROBE_KEY_UP);
        return;
      }
      // Neither key produced any change — nothing interactive is listening,
      // and nothing was recalled, so there is nothing to restore.
      this.probe = null;
      return;
    }
    const beforeParsed = parseInteractivePrompt(p.before);
    const afterParsed = parseInteractivePrompt(after);
    if (!beforeParsed || !afterParsed || !confirmProbeReaction(beforeParsed, afterParsed)) {
      // Not a live overlay reacting to us — either nothing parses, or
      // menu-shaped text is on screen but its highlight didn't move (static
      // prose can't move; only a live menu can).
      this.finishProbeRound(p, 'screen changed without a live highlight move');
      return;
    }
    const turn = p.turn;
    this.probe = null;
    const text = afterParsed.isPermission
      ? formatPermissionPrompt(afterParsed.context, afterParsed.options)
      : formatMenuPrompt(afterParsed.options);
    logWarn(`interactive ${afterParsed.isPermission ? 'permission prompt' : 'menu'} confirmed (${afterParsed.options.length} options, highlight ${beforeParsed.highlighted}→${afterParsed.highlighted}) — bridging to chat`);
    this.bridgeChoiceToChat(turn, afterParsed.options, text);
  }

  /**
   * Single non-confirmed exit for a probe round. When the Up fallback was
   * sent, it may have recalled input-line history into a genuinely idle
   * (non-menu) input box — clear it with Ctrl+U so no stale recalled text is
   * ever prepended to the next submission. Ctrl+U (not a compensating Down)
   * because recalled entries are routinely multi-line (channel envelopes),
   * where a Down may only move the cursor within the text instead of
   * stepping history forward (review round 2, findings 3+5); it is the same
   * clear the interrupt path relies on (abortIfInterrupted()) and a no-op at
   * an empty prompt. Never reached after a confirmed bridge — a live menu
   * consumed the arrows as navigation and its selection is typed as a digit,
   * position-independent of the caret (selectMenuOption()).
   */
  private finishProbeRound(p: ProbeRound, reason: string): void {
    if (p.phase === 'sent-up') this.host.writeRaw('\x15');
    this.probe = null;
    logDebug(`probe round ended without bridging: ${reason}`);
  }

  /**
   * Shared tail of a confirmed probe: emit the channel-native choice UI, carry
   * the same text as the turn's result (API/no-button fallback + chat
   * history), record the pending menu so the reply routes back to a
   * selection, and end the turn so the session goes idle while awaiting the
   * human's choice. Never auto-selects — a destructive/guarded option must
   * always be a human decision.
   */
  private bridgeChoiceToChat(turn: ActiveTurn, options: MenuOption[], text: string): void {
    this.emitter.emitMenuPrompt({ sessionId: this.args.sessionId, prompt: text, options });
    turn.texts.push((turn.texts.length ? '\n\n' : '') + text);
    this.pendingMenu = { options };
    this.finishTurn(false);
  }

  /** Route a user's menu reply (typed number or button tap) to a selection. */
  private handleMenuReply(text: string): void {
    const menu = this.pendingMenu;
    if (!menu) return;
    // Channel turns arrive wrapped in a <channel …>…</channel> envelope, so the
    // bare "1" is buried inside it — unwrap before parsing the selection.
    const choiceText = extractChannelContent(text);
    // Explicit cancel from a "❌ Cancel" button (Telegram/Discord): send ESC to
    // dismiss the menu cleanly without queuing any text into Claude's context.
    // Unlike the "invalid text → ESC + re-queue" path, this leaves the queue
    // empty so the session just returns to the idle prompt with no side-effects.
    if (choiceText === '__MENU_CANCEL__') {
      logWarn('menu cancel received — sending ESC to dismiss');
      this.host.writeRaw('\x1b');
      this.pendingMenu = null;
      // No queue push, no menuCancel needed: ESC dismisses the TUI menu and
      // Claude resumes normally. The session is simply idle again.
      return;
    }
    const n = parseMenuChoice(choiceText, menu.options.length);
    if (n === null) {
      // Not a valid choice — cancel the menu and treat the text as a new prompt
      // so the user can break out by typing an instruction instead of a number.
      // Re-queue the ORIGINAL envelope so Claude still sees the full channel context.
      //
      // ESC makes Claude resume (it processes the menu cancellation), so the TUI
      // is briefly busy/redrawing. Submitting the text immediately races that
      // transition and the prompt never lands → 30-min watchdog hang. Instead we
      // arm menuCancel and let tick() submit once the TUI is back to an idle
      // prompt. trySubmit() is gated on !menuCancel so nothing fires early.
      logWarn(`menu reply "${choiceText.slice(0, 40)}" is not a valid choice — cancelling menu`);
      this.host.writeRaw('\x1b');
      this.pendingMenu = null;
      this.queue.push(text);
      const now = Date.now();
      this.menuCancel = { since: now, lastEscAt: now, escs: 1 };
      return;
    }
    logDebug(`menu selection: ${n}`);
    this.pendingMenu = null;
    this.beginTurn(true);
    void this.selectMenuOption(n);
  }

  /**
   * Inject the keystrokes that select option `n`. Sends the digit, then Enter
   * only if the menu is still on screen — self-correcting whether the TUI
   * confirms on the digit alone or requires Enter.
   */
  private async selectMenuOption(n: number): Promise<void> {
    // Pre-write guard: mirrors typeAndSubmit's pre-paste guard — if SIGINT already fired,
    // skip the write entirely so no digit lands in the PTY input.
    if (this.interrupting || !this.turn) {
      this.queue.length = 0;
      return;
    }
    this.host.writeRaw(String(n));
    await new Promise((r) => setTimeout(r, MENU_SELECT_ENTER_DELAY_MS));
    // If interrupted while waiting, erase the digit so it doesn't linger in the PTY
    // input and get prepended to the user's next message.
    if (this.abortIfInterrupted()) return;
    // Send Enter only if a selectable prompt still visibly blocks the screen —
    // covers both the AskUserQuestion menu and the permission prompt, and
    // self-corrects when the digit alone already confirmed (prompt gone → no
    // stray Enter). interactivePromptBlocking() is deliberately permissive
    // (full viewport): a false positive here costs one stray Enter at an idle
    // empty caret, a no-op.
    if (this.screen.interactivePromptBlocking()) this.host.writeRaw('\r');
    if (this.turn) this.turn.submittedAt = Date.now();
  }

  // ---- lifecycle ------------------------------------------------------------

  private onChildExit(code: number): void {
    if (this.exiting) {
      process.exit(code);
      return;
    }
    logError(`claude exited unexpectedly (code ${code})`);
    if (this.turn) this.finishTurn(true, `claude exited (code ${code})`);
    this.exiting = true;
    this.tailer.stop();
    process.exit(code);
  }

  private shutdown(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tailer.stop();
    if (this.streamSocket) { try { this.streamSocket.destroy(); } catch { /* ignore */ } }
    this.host.kill();
    // PtyHost.onExit will exit(child code); this is the safety net.
    setTimeout(() => process.exit(code), 1500).unref();
  }
}

new Driver().start();
