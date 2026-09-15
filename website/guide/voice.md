# Voice

## Configure one agent

Voice requires gateway orchestration and per-agent `voice.enabled: true`. The `voice` object belongs directly in the agent entry beside `id`, not inside `orchestration`. New agents start with voice disabled.

| Agent voice field | Purpose |
| --- | --- |
| `stt` | Browser microphone transcription |
| `notes` | Uploaded voice-message transcription; `notes.enabled` enables input |
| `tts` | Spoken responses |
| `notes.replyWithVoice` | Whether channel speech replies are permitted |

Configure provider, model, and voice selections before enabling. Keep credentials in environment variables or the connected upstream provider. Model IDs below are integration examples; availability depends on the connected account catalog.

## Choose a connection

### Direct ElevenLabs example

In the gateway's `~/.claude-gateway/.env`, add your own credential:

```dotenv
ELEVENLABS_API_KEY=YOUR_ELEVENLABS_API_KEY
```

Restart after changing this global environment file; configuration hot reload does not reload it. Existing shell/service environment values take precedence. Direct provider credentials belong to the gateway process.

Merge this **partial configuration** into your existing configuration. Retain the agent's workspace, model, channels, and other required fields; replace `assistant` with its existing ID:

```json
{
  "gateway": { "orchestration": true, "headless": true },
  "agents": [{
    "id": "assistant",
    "voice": {
      "enabled": true,
      "tts": { "provider": "elevenlabs", "model": "eleven_flash_v2_5", "voiceId": "" },
      "stt": { "provider": "elevenlabs", "model": "scribe_v2_realtime" },
      "notes": { "enabled": true, "provider": "elevenlabs", "model": "scribe_v2" }
    }
  }]
}
```

An empty `voiceId` selects Auto; select a specific voice from the catalog if desired. Browser realtime STT and uploaded-file STT use different model IDs.

### Upstream ElevenLabs example

Use the voice relay at the **origin of `ANTHROPIC_BASE_URL`**. For example, set the following in your gateway environment file when no higher-priority Claude settings identity is configured:

```dotenv
ANTHROPIC_BASE_URL=https://provider.example.com
ANTHROPIC_AUTH_TOKEN=YOUR_UPSTREAM_TOKEN
```

The provider must implement `/v1/voice/elevenlabs/` and have an active connected ElevenLabs BYOK credential for your account. A messages-only provider cannot provide this relay. This token authenticates to your upstream service, rather than directly to ElevenLabs.

Use the same partial configuration as above, replacing the agent's `voice` object with:

```json
{
  "voice": {
    "enabled": true,
    "tts": { "provider": "upstream:elevenlabs", "model": "eleven_flash_v2_5", "voiceId": "" },
    "stt": { "provider": "upstream:elevenlabs", "model": "scribe_v2_realtime" },
    "notes": { "enabled": true, "provider": "upstream:elevenlabs", "model": "scribe_v2" }
  }
}
```

All three `provider` fields select the upstream route. Models and voice IDs retain their ElevenLabs identifiers. Direct and upstream credentials do not automatically replace one another after a failed request.

The `env` block in `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) takes precedence over inherited environment. Within the selected identity, token precedence is `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`. Credentials resolve as a group: a settings identity cannot silently borrow another identity's exported token. Catalog, preview, STT, and TTS resolve this connection when requested.

No provider API key is sent to the browser. Gemini and PaxaLabs also support direct and upstream modes; use their catalog entries for model selection.

## Verify in stages

1. Select a model and voice from the available catalog and play a preview. Previewing does not change saved agent settings.
2. Enable the agent's voice settings and test a short browser recording. Confirm the transcript before evaluating the response.
3. In a paired Telegram private chat, use `/voice` to select **Always**, **Only reply voice message**, or **Off**. Each chat starts **Off**, independently of the agent capability.
4. Use `/voices` to select a voice, send a short message, and verify both text and audio. Telegram speech follows confirmed text delivery.

Voice replies and controls cover Telegram, Discord, LINE, and Slack in orchestration mode. Unsupported channels return a notice. Per-chat choices persist across session switches and restarts; browser voice choices are independent.

## Recorded input and replay

PaxaLabs, OpenRouter, and Gemini batch transcription use completed recorded segments, not realtime partial transcripts. Gemini browser STT instead uses the realtime adapter when the selected model is `gemini-3.5-transcribe-live`; availability depends on provider access. A pause or microphone mute ends a segment before transcription begins. PaxaLabs live TTS requires `ffmpeg` for MP3 decoding.

Completed browser TTS recordings can be replayed without another provider request. The speaker button appears only when a recording was retained. Retention is up to 30 days with a 64 MiB budget per agent and a 16 MiB per-recording limit; interrupted synthesis is not offered as a completed recording.

If speech is missing, check agent enablement, orchestration, provider/model selection, `notes.replyWithVoice`, and the chat's `/voice` preference in that order. Long reports, code, and URLs are not automatically read as a fallback for missing structured speech.

## STT model versus voice-message STT model

These are two input routes, not two sequential transcription passes:

| Setting | When it runs | Example |
| --- | --- | --- |
| `voice.stt` — STT model | Microphone audio from an active browser voice session | ElevenLabs `scribe_v2_realtime` for partial words while speaking |
| `voice.notes` — Voice message STT model | A completed voice message received through Telegram, Discord, LINE or Slack | ElevenLabs `scribe_v2` for the uploaded recording |
| `voice.tts` — TTS model | Agent speech output after approved spoken text is ready | ElevenLabs, Gemini, PaxaLabs or another supported TTS adapter |

Selecting a batch provider for browser STT is supported, but changes the interaction: recording stops on a committed segment, then transcription runs and the final text appears. Batch adapters do not emit live word suggestions; choose a realtime adapter/model for partial transcripts. Muting the microphone can commit the captured utterance; it does not disable spoken answers while the browser voice session remains connected.

## Provider credentials and model choices

| Provider ID | Credential for direct access | Browser STT | Voice-message STT | TTS |
| --- | --- | --- | --- | --- |
| `elevenlabs` | `ELEVENLABS_API_KEY` | Realtime | Recorded file | Streaming audio |
| `gemini` | `GEMINI_API_KEY` | Realtime with `gemini-3.5-transcribe-live`; otherwise recorded segment | Recorded file | Buffered provider response in the current adapter |
| `paxalabs` | `PAXALABS_API_KEY` | Recorded segment | Recorded file | Supported; browser decoding needs ffmpeg |
| `openrouter` | `OPENROUTER_API_KEY` | Recorded segment | Recorded file | Supported speech models; encoded audio decoding needs ffmpeg |
| `deepgram` | `DEEPGRAM_API_KEY` | Realtime adapter | Not supported by the voice-note upload path | No |
| `cartesia` | `CARTESIA_API_KEY` | No | No | Supported TTS adapter |

Direct and upstream routes are distinct. `upstream:elevenlabs`, `upstream:gemini`, `upstream:paxalabs` and `upstream:openrouter` use the upstream service's credentials and connected BYOK provider. A missing BYOK credential is an error, not permission to silently fall back to another payer. Catalog IDs such as `gemini/gemini-3.1-flash-tts-preview` are accepted only with the matching selected provider; the prefix alone does not select upstream routing.

### Obtain direct provider keys

- **ElevenLabs:** create an API key in your workspace and enable access for the features you use. Voice/model catalog reads and synthesis/transcription permissions are separate: a synthesis-only key can leave the model or voice picker incomplete. Follow [ElevenLabs API key setup](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys) and its [quickstart](https://elevenlabs.io/docs/eleven-api/quickstart).
- **Gemini:** create or select a Google Cloud project in Google AI Studio and create its API key. Put the key in `GEMINI_API_KEY`; account quota/model access still applies. Follow [Google's API key guide](https://ai.google.dev/gemini-api/docs/api-key). The gateway uses the Gemini API, not a Vertex service-account credential in this field.
- **OpenRouter:** set `OPENROUTER_API_KEY` for direct access, or select `upstream:openrouter` to use the connected upstream account. Select a model returned by the voice catalog for the required speech or transcription capability; a chat model is not automatically an audio model.
- **PaxaLabs:** obtain your account API key and verify sufficient credits and model access using the [Paxa API documentation](https://paxalabs.com/docs/text-to-speech). The gateway's environment variable is `PAXALABS_API_KEY`, even where provider examples use a differently named shell variable.

For example, a **partial agent voice configuration** for Gemini:

```json
{
  "voice": {
    "enabled": true,
    "tts": { "provider": "gemini", "model": "gemini-3.1-flash-tts-preview", "voiceId": "Aoede" },
    "stt": { "provider": "gemini", "model": "gemini-2.5-flash" },
    "notes": { "enabled": true, "provider": "gemini", "model": "gemini-2.5-flash" }
  }
}
```

For realtime Gemini browser input, change only `voice.stt.model` to `gemini-3.5-transcribe-live` when your provider offers it. Keep a recorded-file model in `voice.notes` for uploaded voice messages.

For OpenRouter, select `openrouter` (direct) or `upstream:openrouter` (connected upstream account) independently in `voice.tts`, `voice.stt`, and `voice.notes`. Use a speech model for TTS and a transcription model for STT from the catalog; preserve the native model ID, including its publisher prefix. Browser transcription uses recorded segments.

For PaxaLabs, the corresponding integration examples are `paxa-tts-flash-v1` and `paxa-stt-lite-v1-preview`. Its gateway integration supports Thai and English only. Choose another available provider/model for other languages. Do not infer language support solely from the selected voice's gender.

## Turn timing and playback settings

| Setting under `voice` | Default | Meaning |
| --- | --- | --- |
| `language` | empty | Recognition language hint; empty allows automatic recognition |
| `turns.silenceCommitMs` | 650 ms | Pause before committing a microphone segment |
| `turns.finalizationTimeoutMs` | 5000 ms | Base finalization budget; batch providers may require a longer provider-specific budget |
| `turns.maxUtteranceMs` | 60000 ms | Bound a single utterance |
| `playback.maxBufferedAudioMs` | 1500 ms | Bound unacknowledged playback audio |
| `playback.bargeIn` | true | Allow speech interruption behavior |
| `maxActiveSessionsPerConversation` | 1 | Limit concurrent live voice connections for a conversation |

A shorter pause commits sooner and may cut a natural pause into separate segments; a longer pause waits for more speech but delays submission. This is separate from orchestration's `intakeWaitMs`, which combines already received incomplete inputs. The setting is not a promise of end-to-end reply latency.

## Diagnose missing or delayed audio

Start with the text result, the selected route and the error reference. Authentication failures, exhausted quota and temporary provider unavailability require different actions; switching voices does not fix a missing API key or exhausted quota. Auto voice selection requires a readable voice catalog. For a catalog failure, check credentials/model access instead of overwriting the saved selection with an invented voice.

Live voice logs `Voice timing` events with operation `stt` or `tts`, an operation ID, session/response identifiers and phase timestamps. Subtract elapsed times between phases:

1. `speech_ready` → `synthesis_started`: queue wait before TTS.
2. `provider_request_started` → `provider_headers_received`: HTTP provider/proxy wait.
3. `provider_body_received` → `first_provider_audio`: complete-body processing for the Gemini adapter.
4. `first_audio_sent` → `first_playback_progress`: first positive browser playback receipt.

HTTP phases apply to adapters using the shared HTTP helper. They do not identify whether an upstream wait is internal queueing or work inside the final provider; that needs upstream diagnostics. A playback receipt is not an exact audio-device start timestamp. `audio_sent_complete` includes browser backpressure, so it must not be used as time to first sound.

The current Gemini adapter waits for the full provider JSON/audio result before yielding transport chunks. This explains why text can arrive well before audio. It describes the gateway implementation, not a universal restriction of the Gemini service. The gateway does not automatically retry a failed synthesis and risk duplicate or overlapping audio.

The diagnostic payload contains metadata, not transcript text, audio, URLs or provider credentials. See [voice API](../api/voice.md) for error fields, ticket authentication, replay and client reconnect behavior. Static `allowedOrigins` configuration is obsolete; live voice uses authenticated tickets bound to the initiating origin.


## Managed voice credits

Select `managed:elevenlabs` or `managed:paxalabs` with a model from the authenticated provider service’s managed catalog. These routes use its daily voice wallet; direct providers and `upstream:<provider>` BYOK routes keep their own billing. There is no automatic switch between payers.

When managed credits run out, channels quietly skip voice transcription and synthesis while text chat remains available. Saved voice preferences stay unchanged; a subsequent request checks the wallet again after reset. Browser clients should pause voice on `MANAGED_VOICE_QUOTA_EXHAUSTED` until credits become available. An unavailable wallet is a separate retryable error, not evidence that credits are exhausted. See the [Voice API](../api/voice.md#managed-voice-wallet-and-startup-recovery).
