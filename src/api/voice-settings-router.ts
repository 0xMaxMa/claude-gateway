import { randomUUID } from 'crypto';
import { describeVoiceError, providerHttpError } from '../voice/errors';
import { VOICE_PREVIEW_TEXT, voicePreviewLanguages } from '../voice/preview';
import { nativeVoiceModel } from '../voice/providers/model-ref';
import { geminiConnection } from '../voice/providers/gemini';
import { ttsProvider } from '../voice/providers/registry';
import { resolveVoiceId } from '../voice/providers/voice-catalog';
import { PCM16 } from '../voice/types';
import { pcmToWav } from '../voice/wav';
import { paxaConnection } from '../voice/providers/paxalabs-tts';
import { Router, Request } from 'express';
import { readFile } from 'fs/promises';
import { AgentConfig, ApiKey } from '../types';
import { AgentRunner } from '../agent/runner';
import { canAccessAgent, canWriteAgent, createApiAuthMiddleware } from './auth';
import {
  withConfigWriteLock,
  writeConfigAtomic,
} from '../config/config-write-lock';
import {
  ORCHESTRATION_DEFAULTS,
  OrchestrationConfig,
  resolveOrchestrationConfig,
  validateTree,
} from '../orchestration/config';
import {
  effectiveOrchestration,
  migrateAgentVoiceConfig,
  GatewayOrchestration,
} from '../orchestration/gateway-config';
import { voiceChoices } from '../voice/providers/voice-catalog';
import { upstreamVoiceConnection } from '../voice/providers/upstream';

function publicVoiceSettings(config: AgentConfig) {
  const { allowedOrigins: _legacyOrigins, ...voice } = resolveOrchestrationConfig(config.orchestration, config.voice ?? { enabled: false }).voice;
  return voice;
}

function catalogErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'INVALID_UPSTREAM_VOICE_URL') {
    return 'Upstream voice URL is missing or invalid. Check the Claude provider settings.';
  }
  return describeVoiceError(error).message;
}

export function voiceSettingsRouter(
  configs: Map<string, AgentConfig>,
  runners: Map<string, AgentRunner>,
  keys: ApiKey[],
  path?: string,
): Router {
  const router = Router(),
    auth = createApiAuthMiddleware(keys);
  const key = (req: Request) => (req as Request & { apiKey: ApiKey }).apiKey;
  router.get('/v1/agents/:agentId/voice-settings', auth, (req, res) => {
    const id = String(req.params.agentId),
      config = configs.get(id);
    if (!config || !canAccessAgent(key(req), id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    res.json({
      orchestration_enabled: config.orchestration?.enabled === true,
      voice: publicVoiceSettings(config),
      direct_providers: [
        ...(process.env.ELEVENLABS_API_KEY ? ['elevenlabs'] : []),
        ...(process.env.PAXALABS_API_KEY ? ['paxalabs'] : []),
        ...(process.env.GEMINI_API_KEY ? ['gemini'] : []),
        ...(process.env.DEEPGRAM_API_KEY ? ['deepgram'] : []),
        ...(process.env.CARTESIA_API_KEY ? ['cartesia'] : []),
      ],
    });
  });
  router.patch('/v1/agents/:agentId/voice-settings', auth, async (req, res) => {
    const id = String(req.params.agentId),
      config = configs.get(id);
    if (!config || !canWriteAgent(key(req), id)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }
    if (!path) {
      res.status(501).json({ error: 'Config management unavailable' });
      return;
    }
    try {
      validateTree(req.body, ORCHESTRATION_DEFAULTS.voice, 'voice');
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        throw Error('Invalid voice settings');
      await withConfigWriteLock(path, async () => {
        const raw = JSON.parse(await readFile(path, 'utf8')) as {
          gateway: { orchestration?: GatewayOrchestration };
          agents: Array<{ id: string; orchestration?: OrchestrationConfig; voice?: import('../orchestration/config').AgentVoiceConfig }>;
        };
        migrateAgentVoiceConfig(raw);
        const agent = raw.agents.find((a) => a.id === id);
        if (!agent) throw Error('Agent no longer exists');
        const previous = agent.voice ?? {};
        const voice = { ...previous, ...req.body };
        for (const field of [
          'stt',
          'tts',
          'notes',
          'turns',
          'playback',
        ] as const)
          if (req.body[field])
            voice[field] = { ...previous[field], ...req.body[field] };
        const orchestration = { ...agent.orchestration };
        const effective = effectiveOrchestration(
          orchestration,
          raw.gateway.orchestration,
        );
        const resolved = resolveOrchestrationConfig(effective, voice).voice;
        if (
          !['', 'elevenlabs', 'upstream', 'deepgram', 'paxalabs', 'upstream:paxalabs', 'gemini', 'upstream:gemini'].includes(
            resolved.stt.provider,
          ) ||
          !['', 'elevenlabs', 'upstream', 'cartesia', 'paxalabs', 'upstream:paxalabs', 'gemini', 'upstream:gemini'].includes(
            resolved.tts.provider,
          ) ||
          !['', 'elevenlabs', 'upstream', 'paxalabs', 'upstream:paxalabs', 'gemini', 'upstream:gemini'].includes(resolved.notes.provider)
        )
          throw Error('Unsupported voice provider');
        if (resolved.enabled && (
          !resolved.stt.model.trim() ||
          !resolved.tts.model.trim() ||
          (resolved.notes.enabled && !resolved.notes.model.trim())
        ))
          throw Error('Voice models are required');
        for (const role of ['tts', 'stt', 'notes'] as const) if (resolved[role].model && resolved[role].provider) nativeVoiceModel(resolved[role].provider, resolved[role].model);
        delete voice.allowedOrigins;
        agent.voice = voice;
        await writeConfigAtomic(path, raw);
        const updated = { ...config, voice, orchestration: effective };
        runners.get(id)?.updateAgentConfig(updated);
        configs.set(id, updated);
      });
      res.json({
        voice: publicVoiceSettings(configs.get(id)!),
        applies_to: 'next voice connection and subsequent replies',
      });
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error ? error.message : 'Invalid voice settings',
      });
    }
  });
  router.get(
    '/v1/agents/:agentId/voice-settings/catalog',
    auth,
    async (req, res) => {
      const id = String(req.params.agentId);
      if (!configs.has(id) || !canAccessAgent(key(req), id)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      const provider = String(
        req.query.provider ||
          resolveOrchestrationConfig(configs.get(id)!.orchestration, configs.get(id)!.voice ?? { enabled: false }).voice.tts
            .provider,
      );
      if (!['upstream', 'elevenlabs', 'cartesia', 'deepgram', 'paxalabs', 'upstream:paxalabs', 'gemini', 'upstream:gemini'].includes(provider)) {
        res.status(400).json({ error: 'Unsupported provider' });
        return;
      }
      try {
        const warnings: string[] = [];
        let voices: Awaited<ReturnType<typeof voiceChoices>> = [];
        if (provider !== 'deepgram') {
          try { voices = await voiceChoices({ provider, voiceId: '' }); }
          catch (error) { warnings.push(`Voice list unavailable. ${catalogErrorMessage(error)}`); }
        }
        let models: unknown[] = [];
        try {
        if (provider === 'elevenlabs' || provider === 'upstream') {
          try {
            const connection =
              provider === 'upstream' ? upstreamVoiceConnection() : undefined;
            const response = await fetch(
              connection
                ? new URL('models', connection.base)
                : 'https://api.elevenlabs.io/v1/models',
              {
                headers: connection
                  ? { Authorization: `Bearer ${connection.key}` }
                  : { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' },
                signal: AbortSignal.timeout(10000),
                redirect: 'error',
              },
            );
            if (!response.ok) throw await providerHttpError('VOICE', response);
            const result = await response.json();
            if (!Array.isArray(result)) throw Error('Invalid model catalog');
            models = result;
          } catch (error) {
            // Voice and model catalog permissions are independent. A restricted
            // models_read permission must not hide otherwise usable voices.
            warnings.push(
              `Provider model list unavailable. ${catalogErrorMessage(error)} Showing supported models; check models_read permission if access is denied.`,
            );
            models = [
              ['eleven_v3_conversational','Eleven v3 Conversational'],
              ['eleven_v3','Eleven v3'],
              ['eleven_multilingual_v2','Eleven Multilingual v2'],
              ['eleven_flash_v2_5','Eleven Flash v2.5'],
              ['eleven_turbo_v2_5','Eleven Turbo v2.5'],
            ].map(([model_id,name])=>({model_id,name,can_do_text_to_speech:true,catalog_source:'supported_defaults'}));
          }
        }
        if (provider === 'paxalabs' || provider === 'upstream:paxalabs') {
          const { base, key } = paxaConnection(provider);
          const response = await fetch(new URL('models', base), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) throw await providerHttpError('VOICE', response);
          const result = await response.json() as { models?: Array<{ id: string; name?: string }> };
          models = (result.models ?? []).filter(m => /^paxa-(tts|stt)-/.test(m.id)).map(m => ({ model_id: m.id, name: m.name ?? m.id, can_do_text_to_speech: m.id.startsWith('paxa-tts-'), can_do_speech_to_text: m.id.startsWith('paxa-stt-'), realtime: false, voice_messages: m.id.startsWith('paxa-stt-') }));
        }
        if (provider === 'elevenlabs' || provider === 'upstream') {
          // /models exposes synthesis capabilities; Scribe transports have documented IDs.
          models.push(
            {model_id:'scribe_v2_realtime', name:'Scribe v2 Realtime', can_do_text_to_speech:false, can_do_speech_to_text:true, realtime:true, voice_messages:false},
            {model_id:'scribe_v2', name:'Scribe v2', can_do_text_to_speech:false, can_do_speech_to_text:true, realtime:false, voice_messages:true, conversation:false},
            {model_id:'scribe_v1', name:'Scribe v1', can_do_text_to_speech:false, can_do_speech_to_text:true, realtime:false, voice_messages:true, conversation:false},
          );
        }
        if (provider === 'gemini' || provider === 'upstream:gemini') {
          const { base, headers } = geminiConnection(provider);
          const signal = AbortSignal.timeout(15000);
          let pageToken = '';
          for (let page = 0; page < 20; page++) {
            const url = new URL('models', base); url.searchParams.set('pageSize', '100');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const response = await fetch(url, { headers, signal, redirect: 'error' });
            if (!response.ok) throw await providerHttpError('VOICE', response);
            const body = await response.json() as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string };
            for (const model of body.models ?? []) {
              const id = model.name.replace(/^models\//, '');
              if (!model.supportedGenerationMethods?.includes('generateContent')) continue;
              const tts = /^gemini-[\d.]+-(flash|pro)-(preview-tts|tts-preview)$/.test(id);
              const stt = /^gemini-(2\.5-(flash|pro|flash-lite)|3(-|\.\d+-)(flash|pro)(-preview)?)$/.test(id);
              if (tts || stt) models.push({ model_id: id, name: model.displayName ?? id, can_do_text_to_speech: tts, can_do_speech_to_text: stt, realtime: false, voice_messages: stt });
            }
            if (!body.nextPageToken) break;
            pageToken = body.nextPageToken;
          }
        }
        if (provider === 'cartesia') {
          models = [{model_id:'sonic-3',name:'Sonic 3',can_do_text_to_speech:true}];
          warnings.push('Showing the models supported by the Cartesia adapter.');
        }
        if (provider === 'deepgram') {
          const response = await fetch('https://api.deepgram.com/v1/models', {headers:{Authorization:`Token ${process.env.DEEPGRAM_API_KEY ?? ''}`}, signal:AbortSignal.timeout(10000),redirect:'error'});
          if (!response.ok) throw await providerHttpError('VOICE', response);
          const result = await response.json() as {stt?:Array<{name:string;canonical_name?:string;uuid?:string; streaming?:boolean}>};
          models = (result.stt ?? []).filter(m => m.streaming !== false && /nova|enhanced|base/.test(m.canonical_name ?? m.name)).map(m => ({model_id:m.canonical_name ?? m.name,name:m.name,can_do_text_to_speech:false,can_do_speech_to_text:true,realtime:true,voice_messages:false}));
        }
        } catch (error) {
          warnings.push(`Provider model list unavailable. ${catalogErrorMessage(error)}`);
        }
        const byok = provider === 'upstream' || provider.startsWith('upstream:');
        const namespace = provider === 'upstream' ? 'elevenlabs' : provider.replace(/^upstream:/, '');
        const catalogModels = models.map(value => {
          const model = value as { model_id: string; languages?: Array<{ language_id: string }> };
          const supported = model.languages?.length ? model.languages.map(language => language.language_id) : voicePreviewLanguages(provider, model.model_id);
          return { ...model, model_id: byok ? `${namespace}/${model.model_id}` : model.model_id,
            native_model_id: model.model_id, provider: namespace, metered: false,
            source: byok ? 'byok' : 'gateway', supported_languages: supported };
        });
        res.json({ provider, voices, models: catalogModels, warnings });
      } catch (error) {
        res.status(503).json({
          error: `Voice catalog unavailable. ${catalogErrorMessage(error)}`,
        });
      }
    },
  );
  router.post('/v1/agents/:agentId/voice-settings/preview', auth, async (req, res) => {
    const id = String(req.params.agentId);
    if (!configs.has(id) || !canWriteAgent(key(req), id)) { res.status(403).json({ error: 'Write permission required' }); return; }
    const { provider, model, voiceId = '', language = 'en' } = req.body ?? {};
    if (typeof provider !== 'string' || typeof model !== 'string' || typeof voiceId !== 'string' || model.length > 128 || voiceId.length > 128) { res.status(400).json({ error: 'Invalid voice selection' }); return; }
    if (typeof language !== 'string' || !Object.prototype.hasOwnProperty.call(VOICE_PREVIEW_TEXT, language)) { res.status(400).json({ error: 'Unsupported preview language' }); return; }
    if (!voicePreviewLanguages(provider, model).includes(language)) { res.status(400).json({ error: `Preview language '${language}' is not supported by this model. Choose another language or model.` }); return; }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const voice = await resolveVoiceId({ provider, voiceId });
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of ttsProvider({ provider, model }).synthesize({ text: (async function* () { yield VOICE_PREVIEW_TEXT[language]; })(), voiceId: voice, language, outputFormat: PCM16, signal })) {
        size += chunk.bytes.length; if (size > 2 * 1024 * 1024) throw Error('Preview too large');
        chunks.push(Buffer.from(chunk.bytes));
      }
      if (!size) throw Error('No audio');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ mime: 'audio/wav', audio: pcmToWav(Buffer.concat(chunks)).toString('base64') });
    } catch (error) { if (!res.destroyed) { const referenceId = randomUUID(); const diagnostic = describeVoiceError(error); console.warn(JSON.stringify({ event: 'Voice preview failed', agentId: id, provider, model, referenceId, ...diagnostic })); res.status(503).json({ error: diagnostic.message, referenceId, ...diagnostic }); } }
  });
  return router;
}
