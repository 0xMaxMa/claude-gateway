import { Router, Request, Response } from 'express';
import { AgentConfig } from '../types';
import { AgentRunner } from '../agent/runner';
import { verifyTelegramInitData } from '../cli-viewer/telegram-initdata';
import { generateCliMessagePage } from '../ui/cli-viewer-ui';
import { generateVoiceCallPage } from '../ui/voice-call-ui';
import { telegramVoiceCallsEnabled, voiceCallPairings } from '../voice/call-pairing';
import { readTelegramAccess } from '../telegram/access';
import { resolveOrchestrationConfig } from '../orchestration/config';
import type { VoiceApi } from './voice-router';

export interface VoiceCallRouterDeps {
  agents: Map<string, AgentRunner>;
  configs: Map<string, AgentConfig>;
  voiceApi: VoiceApi;
  /** Path of `gateway.publicUrl` ("" at the origin root). */
  basePath(): string;
  telegramStateDir(agentId: string): string;
}

/**
 * Telegram `/call` Mini App routes, mounted at `<base>/voice-call`. No API key:
 * each ticket request proves the Telegram user with signed initData, matches the
 * user the pairing was minted for, and re-checks the receiver's `allowFrom`.
 */
export function createVoiceCallRouter(deps: VoiceCallRouterDeps): Router {
  const router = Router();
  router.get('/:pairingId', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const pairing = voiceCallPairings.get(String(req.params.pairingId));
    const config = pairing && deps.configs.get(pairing.agentId);
    if (!pairing || !config) { res.status(404).send(generateCliMessagePage('Link expired', 'This call link is invalid or has expired. Send /call again.', 'err')); return; }
    const voice = resolveOrchestrationConfig(config.orchestration, config.voice ?? { enabled: false }).voice;
    res.send(generateVoiceCallPage({ pairingId: pairing.pairingId, agentId: pairing.agentId, basePath: deps.basePath(), maxUtteranceMs: voice.turns.maxUtteranceMs }));
  });

  router.post('/:pairingId/ticket', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const pairing = voiceCallPairings.get(String(req.params.pairingId));
    const config = pairing && deps.configs.get(pairing.agentId), runner = pairing && deps.agents.get(pairing.agentId);
    if (!pairing || !config || !runner) { res.status(410).json({ error: 'Call link expired', code: 'CALL_LINK_EXPIRED' }); return; }
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const callToken = typeof req.body?.call_token === 'string' ? req.body.call_token : undefined;
    const botToken = config.telegram?.botToken ?? '';
    // Telegram never refreshes a Mini App's initData, so a call outliving its age
    // limit reconnects on the signature plus the call token checked by claim().
    // Opening a call always needs fresh initData.
    const verified = verifyTelegramInitData(initData, botToken)
      ?? (callToken && pairing.callToken ? verifyTelegramInitData(initData, botToken, Number.POSITIVE_INFINITY) : null);
    if (!verified) { res.status(401).json({ error: 'Invalid initData' }); return; }
    if (verified.userId !== pairing.userId) { res.status(403).json({ error: 'User mismatch' }); return; }
    // The receiver checked access when it sent the button; it may have changed since.
    const access = readTelegramAccess(deps.telegramStateDir(pairing.agentId));
    if (access.dmPolicy === 'disabled' || !access.allowFrom.includes(verified.userId)) { res.status(403).json({ error: 'Not allowed' }); return; }
    if (!telegramVoiceCallsEnabled(config)) { res.status(409).json({ error: 'Voice disabled', code: 'VOICE_DISABLED' }); return; }
    const claim = voiceCallPairings.claim(pairing.pairingId, verified.userId, callToken);
    if (claim === 'gone') { res.status(410).json({ error: 'Call link expired', code: 'CALL_LINK_EXPIRED' }); return; }
    if (claim === 'mismatch') { res.status(403).json({ error: 'User mismatch' }); return; }
    if (claim === 'claimed') { res.status(409).json({ error: 'Call link already used', code: 'CALL_LINK_USED' }); return; }
    // A DM's chat id is the user id; the call speaks in that chat's active session.
    const chatId = verified.userId;
    try {
      const sessionId = await runner.telegramVoiceSession(chatId);
      const result = await deps.voiceApi.mintTicket(pairing.agentId, sessionId, { kind: 'telegram', principalId: `telegram:${verified.userId}`, chatId, threadKey: '' },
        req.headers.origin, config.allow_tools !== false);
      if (result.status === 200) voiceCallPairings.attach(pairing.pairingId, String(result.body.voice_session_id));
      res.status(result.status).json({ ...result.body, call_token: claim.callToken });
    } catch { res.status(503).json({ error: 'Voice call unavailable', call_token: claim.callToken }); }
  });
  return router;
}
