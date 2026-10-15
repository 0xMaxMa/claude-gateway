import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Request header an agent's own MCP tools and the gateway's orchestration proxy send next to their API key. */
export const AGENT_SESSION_TOKEN_HEADER = 'x-gateway-session-token';

const secret = randomBytes(32);

/**
 * Proof that a call comes from the agent process running session `sessionId` of `agentId`. The API key an agent
 * is handed may be any key that can reach it, a non-admin one included, so the key alone cannot tell the agent
 * from an outside caller. The token is minted per spawn, lives only in the process's own environment, and names
 * exactly one session. It dies with the gateway process, as do the agents that hold it.
 */
export function mintAgentSessionToken(agentId: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`${agentId}\0${sessionId}`).digest('hex');
}

export function isAgentSessionToken(presented: unknown, agentId: string, sessionId: string): boolean {
  if (typeof presented !== 'string') return false;
  const want = Buffer.from(mintAgentSessionToken(agentId, sessionId));
  const got = Buffer.from(presented);
  return got.length === want.length && timingSafeEqual(got, want);
}
