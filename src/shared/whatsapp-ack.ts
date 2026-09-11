/**
 * The ack reaction both WhatsApp channels leave on an inbound message while
 * the agent works on it, cleared once the reply lands (Phase 2 of the
 * WhatsApp feature-parity plan, ported from Slack's ack reaction).
 *
 * Lives here rather than in either channel's client so the Baileys manager
 * (src/whatsapp/manager.ts) and the Cloud client (src/api/whatsapp-cloud-client.ts)
 * share ONE value and can never drift into reacting with two different emoji
 * for the same behaviour. ⏳ is the direct equivalent of the
 * `hourglass_flowing_sand` Slack reacts with.
 */
export const WHATSAPP_ACK_EMOJI = '⏳';
