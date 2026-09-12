import { describeVoiceError } from '../voice/errors';
import { Router, Request, Response } from 'express';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { randomBytes, randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentConfig, ApiKey } from '../types';
import { AgentRunner } from '../agent/runner';
import { createApiAuthMiddleware, canAccessAgent } from './auth';
import { apiPrincipal } from '../orchestration/identity';
import { resolveOrchestrationConfig } from '../orchestration/config';
import { sttProvider, ttsProvider } from '../voice/providers/registry';
import { VoiceSession } from '../voice/session';
import { decodeVoiceFrame } from '../voice/protocol';
import { voiceChoices, resolveVoiceId } from '../voice/providers/voice-catalog';
import { PCM16 } from '../voice/types';

interface VoiceTicket {
  agentId: string; sessionId: string; chatId: string; principalId: string;
  voiceSessionId: string; expiresAt: number; origin?: string; allowTools: boolean; model?: string;
}
/** Authenticated voice sessions share conversation ownership with text and task controls. */
export class VoiceApi {
  readonly router = Router();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  private readonly tickets = new Map<string, VoiceTicket>();
  private readonly leases = new Map<string, string>();
  private readonly sessions = new Map<string, { session: VoiceSession; socket: WebSocket; ticket: VoiceTicket }>();
  private readonly pruner: ReturnType<typeof setInterval>;
  constructor(private readonly agents: Map<string, AgentRunner>, private readonly configs: Map<string, AgentConfig>, keys: ApiKey[]) {
    const auth = createApiAuthMiddleware(keys);
    this.router.use('/v1/agents/:agentId', (req, res, next) => {
      if (!req.path.includes('/voice-sessions')) { next(); return; }
      // Direct browser clients authenticate with a non-ambient API key. Never
      // reflect Origin or enable credentialed CORS here. Cookie-based products
      // must authorize requests and apply their own CORS policy at their proxy.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader('Access-Control-Allow-Credentials');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Api-Key, Content-Type'); res.status(204).end(); return;
      }
      next();
    });
    this.pruner = setInterval(() => this.prune(), 10000); this.pruner.unref();
    this.router.get('/v1/agents/:agentId/voice-sessions/voices', auth, async (req: Request, res: Response) => {
      const agentId = String(req.params.agentId), config = this.configs.get(agentId);
      const key = (req as Request & { apiKey: ApiKey }).apiKey;
      if (!config || !canAccessAgent(key, agentId)) { res.status(403).json({ error: 'Access denied' }); return; }
      if (!config.orchestration?.enabled || !config.voice?.enabled) { res.status(409).json({ error: 'Voice disabled' }); return; }
      const tts = resolveOrchestrationConfig(config.orchestration, config.voice ?? { enabled: false }).voice.tts;
      try { res.json({ voices: await voiceChoices(tts), default_voice_id: await resolveVoiceId(tts), auto: !tts.voiceId.trim() }); }
      catch { res.status(503).json({ error: 'Voice list temporarily unavailable' }); }
    });
    this.router.get(['/v1/agents/:agentId/sessions/:sessionId/voice-sessions/replays', '/v1/agents/:agentId/sessions/:sessionId/voice-sessions/replays/:responseId'], auth, async (req: Request, res: Response) => {
      const agentId = String(req.params.agentId), sessionId = String(req.params.sessionId), responseId = req.params.responseId ? String(req.params.responseId) : undefined;
      const key = (req as Request & { apiKey: ApiKey }).apiKey, runner = this.agents.get(agentId);
      if (!runner || !canAccessAgent(key, agentId)) { res.status(403).end(); return; }
      if (responseId && !/^[a-f0-9-]{36}$/i.test(responseId)) { res.status(400).end(); return; }
      try {
        const result = await runner.voiceReplay(sessionId, apiPrincipal(key), responseId);
        res.setHeader('Cache-Control', 'private, no-store');
        if (!responseId) { res.json({ response_ids: result }); return; }
        if (!Buffer.isBuffer(result)) { res.status(404).end(); return; }
        res.type('audio/wav').send(result);
      } catch { res.status(403).end(); }
    });
    this.router.post('/v1/agents/:agentId/sessions/:sessionId/voice-sessions', auth, async (req: Request, res: Response) => {
      const agentId = String(req.params.agentId), sessionId = String(req.params.sessionId);
      const key = (req as Request & { apiKey: ApiKey }).apiKey;
      const config = this.configs.get(agentId), runner = this.agents.get(agentId);
      if (!config || !runner || !canAccessAgent(key, agentId)) { res.status(403).json({ error: 'Access denied' }); return; }
      if (!config.orchestration?.enabled || !config.voice?.enabled) { res.status(409).json({ error: 'Voice disabled' }); return; }
      const voice = resolveOrchestrationConfig(config.orchestration, config.voice ?? { enabled: false }).voice;
      const origin = req.headers.origin;
      const chatId = req.body?.chat_id;
      if (typeof chatId !== 'string' || !await runner.apiSessionExists(chatId, sessionId)) { res.status(404).json({ code: 'SESSION_NOT_FOUND', error: 'Session not found' }); return; }
      try { await runner.authorizeVoiceSession(sessionId, apiPrincipal(key)); }
      catch { res.status(403).json({ error: 'Session access denied' }); return; }
      this.prune();
      const leaseKey = `${agentId}:${sessionId}`;
      if (this.leases.has(leaseKey)) { res.status(409).json({ error: 'Voice session already active' }); return; }
      if (this.tickets.size + this.sessions.size >= 100) { res.status(503).json({ error: 'Voice capacity exceeded' }); return; }
      const ticket = randomBytes(32).toString('hex'), voiceSessionId = randomUUID();
      const value: VoiceTicket = { agentId, sessionId, chatId, principalId: apiPrincipal(key), voiceSessionId,
        expiresAt: Date.now() + 30000, origin, allowTools: config.allow_tools ?? Boolean(key.allow_tools) };
      this.tickets.set(ticket, value); this.leases.set(leaseKey, voiceSessionId);
      res.json({ voice_session_id: voiceSessionId, ticket, expires_at: value.expiresAt, input_format: PCM16, output_format: PCM16,
        capabilities: { full_duplex: true, playback_clear: true, playback_progress: true },
        stream_path: `/api/v1/agents/${encodeURIComponent(agentId)}/voice-sessions/${voiceSessionId}/stream` });
    });
    this.router.delete('/v1/agents/:agentId/sessions/:sessionId/voice-sessions/:voiceSessionId', auth, async (req: Request, res: Response) => {
      const key = (req as Request & { apiKey: ApiKey }).apiKey;
      const id = String(req.params.voiceSessionId);
      const active = this.sessions.get(id);
      const ticketEntry = [...this.tickets].find(([, value]) => value.voiceSessionId === id);
      const owner = active?.ticket ?? ticketEntry?.[1];
      if (!owner || owner.agentId !== req.params.agentId || owner.sessionId !== req.params.sessionId || owner.principalId !== apiPrincipal(key) || !canAccessAgent(key, owner.agentId)) { res.status(404).json({ error: 'Voice session not found' }); return; }
      if (ticketEntry) this.tickets.delete(ticketEntry[0]);
      active?.socket.close(); await active?.session.close(); this.sessions.delete(id); this.releaseLease(owner);
      res.status(204).end();
    });
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/\/api\/v1\/agents\/([^/]+)\/voice-sessions\/([^/]+)\/stream$/);
    if (!match) return false;
    const token = url.searchParams.get('ticket') ?? '', ticket = this.tickets.get(token);
    const deny = () => { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); };
    let agentId: string;
    try { agentId = decodeURIComponent(match[1]); } catch { deny(); return true; }
    if (!ticket || ticket.expiresAt < Date.now() || ticket.agentId !== agentId || ticket.voiceSessionId !== match[2] || ticket.origin !== request.headers.origin) { deny(); return true; }
    const config = this.configs.get(ticket.agentId);
    if (!config?.orchestration?.enabled || !config.voice?.enabled) { deny(); return true; }
    const voice = resolveOrchestrationConfig(config.orchestration, config.voice ?? { enabled: false }).voice;
    // ws can reject the handshake without invoking its upgrade callback.
    // The raw socket owns cleanup even before a VoiceSession exists.
    socket.once('close', () => this.releaseLease(ticket));
    this.tickets.delete(token);
    try { this.wss.handleUpgrade(request, socket, head, ws => {
      const runner = this.agents.get(ticket.agentId)!;
      const send = (message: Record<string, unknown>) => {
        if (message.type === 'voice.error') {
          const referenceId = randomUUID();
          const diagnostic = describeVoiceError(message.code);
          message = { ...message, ...diagnostic, referenceId };
          console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'Voice request failed', agentId: ticket.agentId, sessionId: ticket.sessionId, code: message.code, referenceId, ...diagnostic, stt: voice.stt, tts: { provider: voice.tts.provider, model: voice.tts.model } }));
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
      let session: VoiceSession;
      try {
        session = new VoiceSession(sttProvider(voice.stt), ttsProvider(voice.tts), voice.tts.voiceId,
          { control: send, audio: data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); }, bufferedBytes: () => ws.bufferedAmount },
          (text, utteranceId) => runner.submitVoiceUtterance(ticket.sessionId, ticket.chatId, ticket.principalId, text, utteranceId, ticket.allowTools, ticket.model),
          () => runner.stopVoiceResponse(ticket.sessionId), { ...voice.turns, maxBufferedAudioMs: voice.playback.maxBufferedAudioMs, language: voice.language, mergeWindowMs: 1200 },
          (responseId, progress, state) => runner.recordVoicePlayback(responseId, ticket.principalId, progress, state),
          (responseId, audio) => runner.saveVoiceReplay(ticket.sessionId, ticket.principalId, responseId, audio));
      } catch { send({ type: 'voice.error', code: 'PROVIDER_CONFIGURATION_ERROR' }); ws.close(); this.releaseLease(ticket); return; }
      this.sessions.set(ticket.voiceSessionId, { session, socket: ws, ticket });
      let started = false;
      let selectedGender: string | undefined;
      let unsubscribe: (() => void) | undefined;
      let alive = true;
      const heartbeat = setInterval(() => { if (!alive || !started) { ws.terminate(); return; } alive = false; ws.ping(); }, 30000);
      heartbeat.unref(); ws.on('pong', () => { alive = true; });
      ws.on('message', (data, binary) => {
        void (async () => {
          if (binary) { if (!started) throw new Error('VOICE_NOT_STARTED'); await session.audio(decodeVoiceFrame(Buffer.from(data as Buffer))); return; }
          const control = JSON.parse(data.toString());
          if (!started && control.type !== 'voice.start' && control.type !== 'voice.stop') throw new Error('VOICE_NOT_STARTED');
          if ((control.type === 'voice.start' || control.type === 'voice.configure') && control.model !== undefined) {
            if (typeof control.model !== 'string' || !control.model.trim() || control.model.length > 256 || /[\r\n\0]/.test(control.model)) throw new Error('INVALID_CONTROL');
            ticket.model = control.model;
            send({ type: 'voice.configured', model: ticket.model });
          }
          switch (control.type) {
            case 'voice.start': if (started) throw new Error('VOICE_ALREADY_STARTED'); started = true;
              if (control.voice_id !== undefined) {
                const choice = (await voiceChoices(voice.tts)).find(choice => choice.id === control.voice_id);
                if (typeof control.voice_id !== 'string' || !choice) throw new Error('INVALID_CONTROL');
                selectedGender = choice.gender;
                session.setVoice(control.voice_id);
                send({ type: 'voice.configured', voice_id: control.voice_id });
              }
              if (control.voice_id === undefined) {
                try {
                  const voiceId = await resolveVoiceId(voice.tts);
                  session.setVoice(voiceId);
                  selectedGender = (await voiceChoices(voice.tts).catch(() => [])).find(choice => choice.id === voiceId)?.gender;
                  send({ type: 'voice.configured', voice_id: voiceId });
                } catch { send({ type: 'voice.error', code: 'TTS_UNAVAILABLE' }); }
              }
              unsubscribe = await runner.subscribeVoiceResults(ticket.sessionId, ticket.principalId, result => session.notifyResult(result), () => selectedGender);
              if (ws.readyState !== WebSocket.OPEN) { unsubscribe(); break; }
              await session.start(); break;
            case 'voice.configure': {
              if (control.voice_id === undefined && control.model !== undefined) break;
              if (typeof control.voice_id !== 'string') throw new Error('INVALID_CONTROL');
              const choices = await voiceChoices(voice.tts);
              if (!choices.some(choice => choice.id === control.voice_id)) throw new Error('INVALID_CONTROL');
              selectedGender = choices.find(choice => choice.id === control.voice_id)?.gender;
              session.setVoice(control.voice_id);
              send({ type: 'voice.configured', voice_id: control.voice_id }); break;
            }
            case 'speech.activity': session.speechActivity(); break;
            case 'speech.started': session.speechStarted(control.epoch); break;
            case 'speech.ended': session.speechEnded(control.last_audio_seq); break;
            case 'utterance.commit': await session.commit(control.last_audio_seq, control.final === true); break;
            case 'playback.progress': session.progress(control.epoch, control.sample_offset); break;
            case 'playback.clear.ack': break;
            case 'voice.mute': if (typeof control.muted !== 'boolean' || !['discard', 'commit'].includes(control.policy)) throw new Error('INVALID_CONTROL'); await session.mute(control.muted, control.policy, control.last_audio_seq); break;
            case 'voice.stop': await session.close(); ws.close(); break;
            default: throw new Error('INVALID_CONTROL');
          }
        })().catch(error => send({ type: 'voice.error', code: error.code ?? 'INVALID_CONTROL' }));
      });
      ws.on('error', () => { void session.close(); });
      ws.on('close', () => { unsubscribe?.(); clearInterval(heartbeat); void session.close(); this.sessions.delete(ticket.voiceSessionId); this.releaseLease(ticket); });
      send({ type: 'voice.state', state: 'ready', turn_grouping: true, voice_session_id: ticket.voiceSessionId, generation: session.playback.generation });
    }); } catch {
      this.releaseLease(ticket);
      socket.destroy();
    }
    return true;
  }
  private releaseLease(ticket: VoiceTicket): void {
    const key = `${ticket.agentId}:${ticket.sessionId}`;
    if (this.leases.get(key) === ticket.voiceSessionId) this.leases.delete(key);
  }
  private prune(): void {
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now()) { this.tickets.delete(key); this.releaseLease(ticket); }
  }
  async close(): Promise<void> {
    clearInterval(this.pruner);
    await Promise.allSettled([...this.sessions.values()].map(async value => { value.socket.terminate(); await value.session.close(); }));
    this.sessions.clear(); this.tickets.clear(); this.leases.clear(); this.wss.close();
  }
}
