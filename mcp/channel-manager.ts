/**
 * ChannelManager — lifecycle manager for channel modules.
 * Runs all enabled modules concurrently with automatic restart on failure.
 * Adopts openclaw restart/backoff pattern.
 */

import type { ChannelModule, InboundMessageHandler, ChannelId, ChannelAccountSnapshot } from './types';

const RESTART_POLICY = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
  maxAttempts: 10,
};

type ModuleState = {
  module: ChannelModule;
  controller: AbortController;
  running: boolean;
  attempts: number;
  failed: boolean;
  manuallyStopped: boolean;
  lastError?: string;
};

export function createChannelManager(modules: ChannelModule[]) {
  const states = new Map<ChannelId, ModuleState>();

  function backoffMs(attempt: number): number {
    const base = RESTART_POLICY.initialMs * Math.pow(RESTART_POLICY.factor, attempt);
    const capped = Math.min(base, RESTART_POLICY.maxMs);
    const jitter = capped * RESTART_POLICY.jitter * (Math.random() * 2 - 1);
    return Math.round(capped + jitter);
  }

  async function runModule(
    mod: ChannelModule,
    handler: InboundMessageHandler,
    state: ModuleState,
  ): Promise<void> {
    state.running = true;
    state.controller = new AbortController();

    try {
      await mod.start(handler, state.controller.signal);
    } catch (err) {
      state.running = false;
      state.lastError = err instanceof Error ? err.message : String(err);

      if (state.manuallyStopped || state.controller.signal.aborted) return;

      state.attempts++;
      if (state.attempts >= RESTART_POLICY.maxAttempts) {
        state.failed = true;
        return;
      }

      const delay = backoffMs(state.attempts - 1);
      await new Promise(resolve => setTimeout(resolve, delay));

      if (!state.manuallyStopped && !state.controller.signal.aborted) {
        await runModule(mod, handler, state);
      }
    }
  }

  async function startAll(handler: InboundMessageHandler): Promise<void> {
    const enabledModules = modules.filter(m => m.isEnabled());

    for (const mod of enabledModules) {
      const state: ModuleState = {
        module: mod,
        controller: new AbortController(),
        running: false,
        attempts: 0,
        failed: false,
        manuallyStopped: false,
      };
      states.set(mod.id, state);

      // Fire and forget — each module runs independently
      void runModule(mod, handler, state);
    }
  }

  function stop(channelId: ChannelId): void {
    const state = states.get(channelId);
    if (!state) return;
    state.manuallyStopped = true;
    state.controller.abort();
    state.running = false;
  }

  function stopAll(): void {
    for (const [id] of states) {
      stop(id);
    }
  }

  function getSnapshots(): Map<ChannelId, ChannelAccountSnapshot> {
    const result = new Map<ChannelId, ChannelAccountSnapshot>();
    for (const [id, state] of states) {
      result.set(id, {
        accountId: id,
        running: state.running,
        configured: true,
        lastError: state.lastError,
      });
    }
    return result;
  }

  return { startAll, stop, stopAll, getSnapshots, _states: states };
}
