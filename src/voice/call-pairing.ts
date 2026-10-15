import crypto from 'crypto';
import { ACCESS_TTL_MS, PAIRING_TTL_MS } from '../cli-viewer/pairing-store';

/**
 * A `/call` link, minted for one Telegram user in their DM with the bot.
 *
 * The pairing id in the URL is not a credential: every ticket request also
 * proves the caller with signed Telegram initData. The first ticket claims the
 * pairing and returns a call token, so a forwarded link cannot open a second
 * call; the same page presents the token to reconnect after a 1012 close.
 * Windows reuse the `/cli` pairing lifetimes: the link must be opened within the
 * approval window, and each ticket extends the call by the access lifetime.
 */
export interface VoiceCallPairing {
  pairingId: string;
  agentId: string;
  userId: string;
  callToken?: string;
  expiresAt: number;
}

/** A Telegram DM can hold a call: orchestration serves Telegram and the agent has voice. */
export function telegramVoiceCallsEnabled(config: { orchestration?: { enabled?: boolean; channels?: string[] }; voice?: { enabled?: boolean } } | undefined): boolean {
  return Boolean(config?.orchestration?.enabled && config.orchestration.channels?.includes('telegram') && config.voice?.enabled);
}

export type VoiceCallClaim = { callToken: string } | 'gone' | 'mismatch' | 'claimed';

export class VoiceCallPairings {
  private readonly pairings = new Map<string, VoiceCallPairing>();

  create(agentId: string, userId: string): string {
    const pairingId = crypto.randomBytes(18).toString('hex');
    this.pairings.set(pairingId, { pairingId, agentId, userId, expiresAt: Date.now() + PAIRING_TTL_MS });
    return pairingId;
  }

  get(pairingId: string): VoiceCallPairing | undefined {
    const pairing = this.pairings.get(pairingId);
    return pairing && pairing.expiresAt > Date.now() ? pairing : undefined;
  }

  /** Claim an unclaimed pairing, or continue the call that holds `callToken`. */
  claim(pairingId: string, userId: string, callToken?: string): VoiceCallClaim {
    const pairing = this.get(pairingId);
    if (!pairing) return 'gone';
    if (pairing.userId !== userId) return 'mismatch';
    if (pairing.callToken) {
      const presented = Buffer.from(callToken ?? ''), expected = Buffer.from(pairing.callToken);
      if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return 'claimed';
    } else pairing.callToken = crypto.randomBytes(32).toString('hex');
    pairing.expiresAt = Date.now() + ACCESS_TTL_MS;
    return { callToken: pairing.callToken };
  }

  prune(): void {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(id);
  }
}

/** Process-wide store shared by the runner callback and the gateway routes. */
export const voiceCallPairings = new VoiceCallPairings();
