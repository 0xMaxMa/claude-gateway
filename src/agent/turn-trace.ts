/**
 * Turn-trace watchdog core (Epic #195, Phase 1).
 *
 * A "turn" moves through a fixed sequence of pipeline checkpoints, from an
 * inbound message to the reply landing back in the channel. When a turn wedges,
 * knowing *which* stage it is stuck in is the difference between a useful
 * incident and a bare "it's stuck" — the three delivery bugs fixed in
 * #193/#194 each map to a distinct stage (a TUI wedge mid-turn, an orphaned
 * `.forward`, a menu that never rendered).
 *
 * This module is the pure decision core: given a plain observation of the
 * on-disk turn artifacts (signal file, .heartbeat, .processing, .status,
 * .forward, .menu, .replied, .error) and the current time, it reports the
 * turn's current stage, how long it has sat there, and whether that exceeds
 * the stage's timeout budget. It performs NO IO and imports nothing, so it is
 * unit-testable without a filesystem or a live session — the same pattern as
 * orphan-wake.ts / menu-cancel.ts.
 *
 * Recovery actions and incident persistence are deliberately out of scope here
 * (Phase 2/3); this module only observes and classifies.
 */

/**
 * The lifecycle stages a turn passes through, in order. A "stage" is the
 * interval between reaching one checkpoint and reaching the next — the turn is
 * "in stage X" while it waits for the checkpoint that ends X.
 *
 * `inbound` (checkpoint 1→2, before the signal file exists) has no on-disk
 * artifact to observe from the typing directory, so `classifyTurn` never
 * returns it in Phase 1; it is retained in the vocabulary for a future
 * receiver-side hook and for incident fingerprints.
 */
export type TurnStage =
  | 'idle'      // no active turn
  | 'inbound'   // 1→2: inbound accepted, waiting for the typing signal file
  | 'inject'    // 2→3: signal created, waiting for injection into the session
  | 'startup'   // 3→4: injected, waiting for Claude's first output
  | 'progress'  // 4→6: Claude producing output, waiting for the turn to end
  | 'delivery'  // 6→7: turn ended, waiting for a delivery artifact
  | 'dispatch'  // 7→8: artifact written, waiting for the channel to consume it
  | 'done'      // terminal (error flagged, or fully delivered)

/** Where in the pipeline a stall is attributed. */
export type TurnFailureClass =
  | 'channel-in'       // inbound stage: receiver/channel ingress
  | 'runner'           // inject stage: AgentRunner routing/spawn
  | 'session-process'  // startup stage: session/CLI process startup
  | 'claude-cli'       // progress stage: Claude (headless) not producing output
  | 'tui-overlay'      // progress stage: Claude (PTY) wedged on a TUI overlay
  | 'delivery-file'    // delivery stage: turn ended but no artifact appeared
  | 'receiver-out'     // dispatch stage: artifact written but not sent

/**
 * Per-stage timeout budgets (ms). A turn that sits in a stage longer than its
 * budget is reported as stalled and eligible for an incident. Budgets are
 * intentionally conservative to avoid false positives; `progress` matches the
 * established `STALLED_TIMEOUT_MS` (5 min) "no output" bound so telemetry lines
 * up with the existing user-facing stalled check.
 */
export const TURN_STAGE_BUDGETS_MS: Record<TurnStage, number> = {
  idle: Infinity,
  inbound: 30_000,
  inject: 30_000,
  startup: 120_000,
  progress: 300_000,
  delivery: 30_000,
  dispatch: 15_000,
  done: Infinity,
}

/** Default failure attribution for each stage. */
const STAGE_FAILURE_CLASS: Record<TurnStage, TurnFailureClass | null> = {
  idle: null,
  inbound: 'channel-in',
  inject: 'runner',
  startup: 'session-process',
  progress: 'claude-cli',
  delivery: 'delivery-file',
  dispatch: 'receiver-out',
  done: null,
}

/**
 * A plain, disk-derived snapshot of one turn's artifacts. All timestamps are
 * epoch ms; `null` means the corresponding file is absent. Booleans are file
 * presence. Nothing here touches the filesystem — the observer builds it.
 */
export interface TurnObservation {
  /** Current wall-clock time (epoch ms). */
  now: number
  /** Signal file present → its write timestamp; null → no active turn. */
  signalAt: number | null
  /** Parsed `.status` label (queued/thinking/tool/...); null → file absent. */
  statusLabel: string | null
  /** `.heartbeat` mtime — proves Claude has produced output; null → absent. */
  heartbeatAt: number | null
  /** `.processing` mtime — mid-turn sentinel; null → absent. */
  processingAt: number | null
  /** `.forward` mtime — auto-forward delivery artifact; null → absent. */
  forwardAt: number | null
  /** `.menu` mtime — interactive-menu delivery artifact; null → absent. */
  menuAt: number | null
  /** `.replied` present — the reply tool already sent this turn's text. */
  repliedPresent: boolean
  /** `.error` present — the runner flagged a handled failure. */
  errorPresent: boolean
  /** Backend, if known — refines the progress-stall failure class. */
  backend?: 'pty' | 'headless'
}

/** The watchdog's read of a single turn at a point in time. */
export interface TurnTrace {
  stage: TurnStage
  stalled: boolean
  failureClass: TurnFailureClass | null
  /** How long the turn has been in the current stage (ms). */
  sinceMs: number
  /** The current stage's timeout budget (ms). */
  budgetMs: number
}

function makeTrace(
  stage: TurnStage,
  sinceMs: number,
  failureClass: TurnFailureClass | null,
): TurnTrace {
  const budgetMs = TURN_STAGE_BUDGETS_MS[stage]
  return {
    stage,
    sinceMs,
    budgetMs,
    failureClass,
    stalled: sinceMs >= budgetMs,
  }
}

/**
 * Classify a turn's current stage and whether it has stalled. Pure: no IO, no
 * clock reads (the caller passes `now`), no imports.
 */
export function classifyTurn(obs: TurnObservation): TurnTrace {
  // A flagged error is a handled terminal — the error path (notifyError + stop)
  // owns it, so the watchdog must not also raise a stall for it.
  if (obs.errorPresent) {
    return makeTrace('done', 0, null)
  }

  const hasArtifact = obs.forwardAt !== null || obs.menuAt !== null
  const active = obs.signalAt !== null || hasArtifact

  // No live turn and nothing pending delivery → idle.
  if (!active) {
    return makeTrace('idle', 0, null)
  }

  // A delivery artifact on disk is checkpoint 7: the turn produced output and
  // is waiting for a channel poller to consume and send it. Lingering past the
  // dispatch budget means the send side is wedged — an orphaned `.forward`
  // (bug 3) or a `.menu` that never rendered (bug 2).
  if (hasArtifact) {
    const artifactAt = Math.max(obs.forwardAt ?? 0, obs.menuAt ?? 0)
    const sinceMs = Math.max(0, obs.now - artifactAt)
    return makeTrace('dispatch', sinceMs, STAGE_FAILURE_CLASS.dispatch)
  }

  // Signal file present, no delivery artifact yet → the turn is in flight.
  // `active && !hasArtifact` guarantees signalAt is non-null here.
  const signalAt = obs.signalAt as number

  if (obs.heartbeatAt !== null) {
    // Claude has produced output at least once → progress stage. Liveness is
    // the freshest of heartbeat / processing / signal timestamps.
    const lastProgress = Math.max(obs.heartbeatAt, obs.processingAt ?? 0, signalAt)
    const sinceMs = Math.max(0, obs.now - lastProgress)
    // A PTY-mode progress stall is most often a wedged TUI overlay; a headless
    // one is the CLI not producing output. Default to claude-cli when unknown.
    const cls: TurnFailureClass =
      obs.backend === 'pty' ? 'tui-overlay' : 'claude-cli'
    return makeTrace('progress', sinceMs, cls)
  }

  // No heartbeat yet → Claude has not started producing output.
  const sinceMs = Math.max(0, obs.now - signalAt)
  if (obs.statusLabel !== null) {
    // A status label means the turn was injected and the session accepted it,
    // but no output has appeared → session/CLI startup is slow or wedged.
    return makeTrace('startup', sinceMs, STAGE_FAILURE_CLASS.startup)
  }
  // Signal file exists but nothing downstream has reacted (no status) → the
  // runner has not injected the turn into a session yet.
  return makeTrace('inject', sinceMs, STAGE_FAILURE_CLASS.inject)
}

/** A stall detected by the watchdog, handed to a sink for logging/persistence. */
export interface TurnIncident {
  chatId: string
  stage: TurnStage
  failureClass: TurnFailureClass | null
  sinceMs: number
  budgetMs: number
  /** True when a fresh `.processing` sentinel shows the turn is genuinely
   *  mid-work (e.g. a long sub-agent) rather than silently wedged. */
  midTurn: boolean
  /** When the incident was raised (epoch ms). */
  at: number
}

/** Consumer of watchdog incidents. Phase 1 logs; Phase 2 persists + dedupes. */
export type TurnIncidentSink = (incident: TurnIncident) => void

/** One-line, log-friendly rendering of an incident. */
export function formatTurnIncident(incident: TurnIncident): string {
  const since = Math.round(incident.sinceMs / 1000)
  const budget = Math.round(incident.budgetMs / 1000)
  const cls = incident.failureClass ?? 'none'
  const mid = incident.midTurn ? ' mid-turn' : ''
  return `[turn-trace] chat=${incident.chatId} stage=${incident.stage} class=${cls} stuck=${since}s budget=${budget}s${mid}`
}
