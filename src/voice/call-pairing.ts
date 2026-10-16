import crypto from 'crypto';
import { ACCESS_TTL_MS, PAIRING_TTL_MS } from '../cli-viewer/pairing-store';
import { formatCallDuration } from '../ui/voice-call-client';

/**
 * A `/call` link, minted for one Telegram user in their DM with the bot.
 *
 * The pairing id in the URL is not a credential: every ticket request also
 * proves the caller with signed Telegram initData. The first ticket claims the
 * pairing and returns a call token, so a forwarded link cannot open a second
 * call; the same page presents the token to reconnect after a 1012 close.
 * Windows reuse the `/cli` pairing lifetimes: the link must be opened within the
 * approval window, and a call stays reconnectable for the access lifetime after
 * its last ticket or the last time it was seen connected.
 */
export interface VoiceCallPairing {
  pairingId: string;
  agentId: string;
  userId: string;
  /** Topic of the private chat `/call` was sent in; '' for the main chat. */
  threadKey: string;
  callToken?: string;
  /** Voice session of the latest ticket, so a connected call keeps its pairing alive. */
  voiceSessionId?: string;
  expiresAt: number;
  /** The call in progress: from the first connected socket until hang-up, or until
   * no socket has rejoined for `CALL_END_GRACE_MS`. Reconnects belong to the same call. */
  call?: { startedAt: number; connected: boolean; endTimer?: ReturnType<typeof setTimeout>; ended(durationMs: number): void };
}

/** How long a dropped call waits to be rejoined before it counts as ended. The
 * page reconnects within seconds after a network drop or recognizer restart, and
 * rejoins when the Mini App is shown again. */
export const CALL_END_GRACE_MS = 60_000;

/** The chat notice for a finished call. */
export function voiceCallEndedText(durationMs: number): string {
  return `📞 Call ended · ${formatCallDuration(durationMs)}`;
}

/** A Telegram DM can hold a call: orchestration serves Telegram and the agent has voice. */
export function telegramVoiceCallsEnabled(config: { orchestration?: { enabled?: boolean; channels?: string[] }; voice?: { enabled?: boolean } } | undefined): boolean {
  return Boolean(config?.orchestration?.enabled && config.orchestration.channels?.includes('telegram') && config.voice?.enabled);
}

export type VoiceCallClaim = { callToken: string } | 'gone' | 'mismatch' | 'claimed';

export class VoiceCallPairings {
  private readonly pairings = new Map<string, VoiceCallPairing>();

  create(agentId: string, userId: string, threadKey = ''): string {
    const pairingId = crypto.randomBytes(18).toString('hex');
    this.pairings.set(pairingId, { pairingId, agentId, userId, threadKey, expiresAt: Date.now() + PAIRING_TTL_MS });
    return pairingId;
  }

  get(pairingId: string): VoiceCallPairing | undefined {
    const pairing = this.pairings.get(pairingId);
    return pairing && pairing.expiresAt > Date.now() ? pairing : undefined;
  }

  /** Claim an unclaimed pairing, or continue the call that holds `callToken`.
   * The page proposes its token on the first claim, so a lost response can be retried. */
  claim(pairingId: string, userId: string, callToken?: string): VoiceCallClaim {
    const pairing = this.get(pairingId);
    if (!pairing) return 'gone';
    if (pairing.userId !== userId) return 'mismatch';
    if (pairing.callToken) {
      const presented = Buffer.from(callToken ?? ''), expected = Buffer.from(pairing.callToken);
      if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return 'claimed';
    } else pairing.callToken = callToken && /^[0-9a-f]{64}$/.test(callToken) ? callToken : crypto.randomBytes(32).toString('hex');
    pairing.expiresAt = Date.now() + ACCESS_TTL_MS;
    return { callToken: pairing.callToken };
  }

  /** Record the voice session a ticket opened for this call. A ticket that replaced a
   * still-connected socket counts as its disconnect: that socket's close is no longer
   * this call's, so without it a page closed before the new socket connects never ends. */
  attach(pairingId: string, voiceSessionId: string, now = Date.now()): void {
    const pairing = this.get(pairingId);
    if (!pairing) return;
    if (pairing.voiceSessionId && pairing.voiceSessionId !== voiceSessionId) this.disconnected(pairing.voiceSessionId, false, now);
    pairing.voiceSessionId = voiceSessionId;
  }

  /** A socket of this call started listening. The first one starts the call; `ended`
   * reports its length once, when the call ends. */
  connected(voiceSessionId: string, ended: (durationMs: number) => void, now = Date.now()): void {
    const pairing = this.bySession(voiceSessionId);
    if (!pairing) return;
    if (pairing.call) { clearTimeout(pairing.call.endTimer); pairing.call = { ...pairing.call, connected: true, endTimer: undefined, ended }; }
    else pairing.call = { startedAt: now, connected: true, ended };
  }

  /** A socket of this call closed. A hang-up ends the call now; otherwise it ends
   * at this disconnect unless a socket rejoins within the grace period. */
  disconnected(voiceSessionId: string, hangup: boolean, now = Date.now()): void {
    const pairing = this.bySession(voiceSessionId), call = pairing?.call;
    if (!pairing || !call?.connected) return;
    call.connected = false;
    if (hangup) { this.end(pairing, now); return; }
    call.endTimer = setTimeout(() => this.end(pairing, now), CALL_END_GRACE_MS);
    call.endTimer.unref?.();
  }

  /** How long the call has run, for a page rejoining it; undefined when no call is in progress. */
  elapsed(pairingId: string, now = Date.now()): number | undefined {
    const call = this.get(pairingId)?.call;
    return call ? now - call.startedAt : undefined;
  }

  private end(pairing: VoiceCallPairing, endedAt: number): void {
    const call = pairing.call;
    if (!call) return;
    clearTimeout(call.endTimer); pairing.call = undefined;
    call.ended(Math.max(0, endedAt - call.startedAt));
  }

  private bySession(voiceSessionId: string): VoiceCallPairing | undefined {
    for (const pairing of this.pairings.values()) if (pairing.voiceSessionId === voiceSessionId) return pairing;
    return undefined;
  }

  /** Extend calls that are still connected, then drop expired pairings. */
  prune(connected: (voiceSessionId: string) => boolean = () => false): void {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) {
      if (pairing.voiceSessionId && connected(pairing.voiceSessionId)) pairing.expiresAt = Math.max(pairing.expiresAt, now + ACCESS_TTL_MS);
      if (pairing.expiresAt <= now) this.pairings.delete(id);
    }
  }
}

/** Process-wide store shared by the runner callback and the gateway routes. */
export const voiceCallPairings = new VoiceCallPairings();
