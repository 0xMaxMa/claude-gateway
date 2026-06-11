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
import * as readline from 'readline';
import { translateArgs, sanitizeUserText } from './args';
import { ScreenModel } from './screen';
import { PtyHost } from './pty-host';
import { TranscriptTailer, AssistantRecord, UsageInfo } from './tailer';
import { ProtocolEmitter } from './emitter';

const POLL_MS = 200;
const STARTUP_QUIET_MS = 600;
const SUBMIT_ENTER_DELAY_MS = 300;
const SUBMIT_RETRY_AFTER_MS = 4000;
const MAX_ENTER_RETRIES = 2;
const FALLBACK_IDLE_QUIET_MS = 2000;
const DIALOG_ACTION_COOLDOWN_MS = 2000;
const STARTUP_TIMEOUT_MS = 120_000;
const WATCHDOG_MS = process.env.PTY_SHELL_WATCHDOG_MS
  ? Number(process.env.PTY_SHELL_WATCHDOG_MS) || (30 * 60 * 1000)
  : 30 * 60 * 1000;
// Set PTY_SHELL_SKIP_DIALOG_DISMISS=1 to disable all TUI dialog auto-dismiss.
// Use when a new Claude Code version changes TUI text and dialog patterns break.
const SKIP_DIALOG_DISMISS = process.env.PTY_SHELL_SKIP_DIALOG_DISMISS === '1';

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
}

class Driver {
  private ready = false;
  private exiting = false;
  private startedAt = Date.now();
  private queue: string[] = [];
  private turn: ActiveTurn | null = null;
  private lastDialogActionAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private host!: PtyHost;
  private tailer!: TranscriptTailer;

  private readonly screen = new ScreenModel();
  private readonly emitter = new ProtocolEmitter();
  private readonly args = translateArgs(process.argv.slice(2));
  // CLAUDE_REAL_BIN may be multi-word (e.g. "node /path/cli.js"), same as CLAUDE_BIN.
  private readonly realBinParts = (process.env.CLAUDE_REAL_BIN ?? 'claude').split(' ');

  start(): void {
    const [realBin, ...realBinArgs] = this.realBinParts;
    logDebug(`session=${this.args.sessionId} bin=${this.realBinParts.join(' ')} args=${this.args.claudeArgs.join(' ')}`);

    this.host = new PtyHost(realBin, [...realBinArgs, ...this.args.claudeArgs], {
      cols: this.screen.cols,
      rows: this.screen.rows,
      cwd: process.cwd(),
      onData: (d) => this.screen.write(d),
      onExit: (code) => this.onChildExit(code),
    });

    this.tailer = new TranscriptTailer(process.cwd(), this.args.sessionId, {
      onAssistant: (record) => this.onAssistant(record),
      onTurnEnd: (durationMs) => this.onTurnEnd(durationMs),
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
    if (this.turn) {
      this.turn.sawAssistant = true;
      this.turn.lastProgressAt = Date.now();
      if (text) this.turn.texts.push(text);
      if (usage) this.turn.usage = usage;
    } else {
      logDebug('assistant record outside an active turn (emitted anyway)');
    }
  }

  private onTurnEnd(durationMs: number): void {
    logDebug(`turn_duration record (${durationMs}ms)`);
    if (this.turn) this.finishTurn(false);
  }

  private finishTurn(isError: boolean, errMsg?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
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
  }

  // ---- turn submission -----------------------------------------------------

  private trySubmit(): void {
    if (!this.ready || this.turn || this.queue.length === 0 || this.exiting) return;
    const text = this.queue.shift() as string;
    const now = Date.now();
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
    };
    void this.typeAndSubmit(text);
  }

  private async typeAndSubmit(text: string): Promise<void> {
    // Bracketed paste so multiline text cannot submit early; \r must be a
    // separate delayed write or the TUI treats it as part of the paste.
    await this.host.writeChunked(`\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
    this.host.writeRaw('\r');
    if (this.turn) this.turn.submittedAt = Date.now();
  }

  // ---- periodic liveness poll ----------------------------------------------

  private lastDumpAt = 0;

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

    const turn = this.turn;
    if (!turn || turn.submittedAt === 0) return;

    if (this.screen.consumeBusySeen() || this.screen.isBusy()) {
      turn.sawBusy = true;
      turn.lastProgressAt = now;
      return;
    }

    // Not busy. Possible: still rendering, swallowed Enter, dialog, or done
    // (turn_duration normally ends the turn before we get here).
    this.maybeHandleDialog();

    if (!turn.sawBusy
        && now - turn.submittedAt > SUBMIT_RETRY_AFTER_MS
        && this.screen.hasPrompt()
        && this.screen.quietMs() > 1500
        && this.tailer.seenRecords === 0) {
      // Only retry if the transcript is empty — a non-zero seenRecords means
      // claude already started writing output (just slow to show "esc to interrupt").
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
    if (turn.sawBusy && turn.sawAssistant
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
    if (this.screen.quietMs() < 500) return; // wait until the dialog is fully drawn
    const dialog = this.screen.detectDialog();
    if (!dialog) return;
    this.lastDialogActionAt = now;

    switch (dialog) {
      case 'bypass-permissions':
        // --dangerously-skip-permissions is built into the wrapper, so the
        // confirmation dialog is always accepted on the operator's behalf.
        logWarn('accepting Bypass Permissions dialog (per built-in --dangerously-skip-permissions)');
        this.host.writeRaw('2');
        break;
      case 'trust-folder':
        // The gateway only ever runs claude in its own agent workspaces.
        logWarn('accepting workspace trust dialog');
        this.host.writeRaw('\r');
        break;
      case 'unknown-select':
        if (!this.turn) break;
        this.turn.dialogEscapes++;
        logError(`unexpected dialog during turn (escape ${this.turn.dialogEscapes}/2):\n${this.screen.text()}`);
        if (this.turn.dialogEscapes <= 2) {
          this.host.writeRaw('\x1b');
        } else {
          this.finishTurn(true, 'blocked by an unexpected TUI dialog');
        }
        break;
    }
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
    this.host.kill();
    // PtyHost.onExit will exit(child code); this is the safety net.
    setTimeout(() => process.exit(code), 1500).unref();
  }
}

new Driver().start();
