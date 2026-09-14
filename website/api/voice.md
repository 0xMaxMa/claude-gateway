# Voice API {#voice-api}

Voice requires gateway orchestration and `agents[].voice.enabled`. See [orchestration configuration](/guide/orchestration).

## Channel speech failures {#channel-speech-failures}

Telegram, Discord, LINE and Slack deliver the response text before speech. If
synthesis fails, the same response/destination gets one durable plain-text notice
explaining that audio could not be created, with a normalized provider diagnostic.
All provider failures use concise, provider-independent wording, retain the HTTP
status when available, and suggest a relevant action or `/voice off`. Chat notices
omit technical details and reference IDs; the failed delivery ID remains the log
reference. Quota, rate limit, payment, authentication, permission, unavailable,
timeout, network, language/model, invalid response and unknown errors each have
short messages. Unknown future failures use a safe generic notice. The failure and pending notice are
committed together; a restart does not duplicate the notice or retry paid synthesis.
Gateway logs and the delivery outbox retain the normalized failure code. Raw
provider messages and credentials are never included. A Google structured daily
quota violation is identified as a daily limit; a bare HTTP 429 remains ambiguous
between rate limiting and exhausted quota. Turning voice off or an uncertain
channel send does not produce a misleading synthesis-failure notice.


## Telegram voice notes {#telegram-voice-notes}

Voice-note failures retain normalized provider codes in `voice_note_transcripts`
and return a readable provider diagnostic plus a `Reference` input ID in the
original conversation. Gateway logs record the same reference, provider, model,
HTTP status and category without raw provider messages or credentials. This
applies to the shared voice-note flow across channels, including Gemini and Paxa
errors and ElevenLabs batch HTTP errors. A failed note is not automatically
retried; quota/payment/configuration failures should be resolved before resending.

For orchestration-enabled Telegram ingress, `agents[].voice.enabled` together with `agents[].voice.notes.enabled` enables transcription. Outgoing voice controls are available by default; set `agents[].voice.notes.replyWithVoice: false` to deny them for an Agent. The old gateway-level `replyWithVoice` value is ignored. Inbound transcription can be disabled independently. Voice synthesis requires an ElevenLabs or Cartesia `voice.tts` provider and an optional `voiceId` (empty selects Auto), without a browser WebSocket. Authorized users in private chats use `/voice` and its Always / Voice messages only / Off buttons, or `/voice on`, `/voice auto` and `/voice off` directly. The preference is stored per Agent/chat in `telegram_voice_preferences`, defaults to Off even when voice capability is enabled, and survives session switches/restarts. On enables bounded spoken summaries for both typed and voice-note replies and automatic Worker reports; Off keeps text-only responses. The English menu includes Dismiss, which closes it without changing the preference. Successful mode selection replaces the menu with a persistent confirmation. The menu never invokes inference or TTS. Pending audio checks the preference before synthesis and again before Telegram submission; a send already submitted cannot be recalled by this toggle.

Voice reply mode `auto` sends audio only for voice-origin inputs and their dependent task results; typed-only conversations remain text-only. Modes apply to Telegram, Discord, LINE and Slack. Preferences are stored in `voice_reply_modes` per Agent/chat, with old boolean preferences used as a fallback; old On/Off choices retain their meaning. Browser live voice remains independent.

The gateway synthesizes MP3 and submits Telegram `sendVoice` to the original bound chat/topic. Speech deliveries have their own durable outbox entry and provider message receipt, with the voice/model pinned when queued. Failed synthesis keeps the text reply available. Ambiguous sends remain `unknown` for reconciliation and are not blindly retried. Voice-enabled Agent turns use CLI JSON-schema validation for display_text and spoken_text, and consume structured_output from the terminal result. Short plain conversational replies (up to 600 characters, without code, URLs or structured data) can be spoken directly in their original language. Long reports require the explicit spoken summary and are never truncated into audio. Browser voice changes do not change the Agent-configured Telegram voice.

`/voices` uses the same provider-neutral catalog as web Voice controls. ElevenLabs and Cartesia adapters list real provider voices; Cartesia pages through its [voice catalog API](https://docs.cartesia.ai/api-reference/voices/list). Each chat’s choice is stored in `telegram_tts_voices`, scoped to the provider. Telegram menus first select a gender category, then show paginated voice names with ✅ on the selected voice and Back/Dismiss controls. Menus are bound to the chat/provider for five minutes. Selection does not enable auto voice replies. Changed providers require a new selection if the chat had explicitly selected an old provider’s voice. Missing catalogs report unavailable rather than inventing voices. Speech file output supports native MP3 through ElevenLabs and Cartesia; other providers need a catalog and file-synthesis adapter.

Telegram registers `/tasks`, `/voice` and `/voices` only with orchestration enabled for Telegram. `/cli` is registered only with `gateway.headless: false`, and is hidden for app-agents and orchestration agents. Help and callback handling follow the same capability checks. Hot-reloading orchestration/headless mode refreshes receiver command registration without stopping Agent/Worker tasks.

Telegram `/tasks` is a direct gateway control for the active chat session. Its paginated list and detail callbacks check conversation membership; cancellation checks the task ID against the current session before calling the same user-cancellation service as `/stop`. Viewing/refreshing tasks does not interrupt Agent responses. Old task buttons cannot cancel work after switching to another session. Progress is the latest worker/runtime report, not an inferred percentage.


## Live voice endpoints {#live-voice-endpoints}

For direct and upstream provider values, API-key locations, and per-Agent examples, see [Setting up voice providers](/guide/voice).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/agents/:agentId/voice-settings` | Effective voice settings and `orchestration_enabled`; requires access to this Agent |
| `PATCH` | `/api/v1/agents/:agentId/voice-settings` | Persist a partial Agent voice override; requires write permission for this Agent |
| `GET` | `/api/v1/agents/:agentId/voice-settings/catalog?provider=upstream` | Provider voice/model catalog for the settings UI; provider may also be `elevenlabs`, `cartesia`, `deepgram`, `paxalabs`, or `upstream:paxalabs` |
| `GET` | `/api/v1/agents/:agentId/voice-sessions/voices` | Available voices: `{ voices: [{ id, name, gender? }], default_voice_id }` |
| `POST` | `/api/v1/agents/:agentId/sessions/:sessionId/voice-sessions` | Create a voice lease and single-use WebSocket ticket; body `{ "chat_id": "<chat-id>" }` |
| `GET` (WebSocket upgrade) | `/api/v1/agents/:agentId/voice-sessions/:voiceSessionId/stream?ticket=<ticket>` | Duplex audio/control stream |
| `DELETE` | `/api/v1/agents/:agentId/sessions/:sessionId/voice-sessions/:voiceSessionId` | Close the owned voice lease; returns `204` |

HTTP endpoints require an authorized API key. Voice must be enabled at `agents[].voice.enabled`, with gateway orchestration enabled. Ticket creation verifies the existing chat/session pair and principal. Only one voice lease is allowed per conversation. Tickets expire after 30 seconds and are consumed at upgrade; the WebSocket must use the same Origin as ticket creation. No public URL or `voice.allowedOrigins` setup is required. Direct browser requests use API-key authentication with non-credentialed CORS; cookie-authenticated products must enforce session ownership and credentialed CORS at their trusted proxy. The legacy `allowedOrigins` field is ignored. Disabled voice or an occupied lease returns `409`; ownership/origin errors are rejected. Do not send the API key in the WebSocket URL.

Creation returns `voice_session_id`, `ticket`, `expires_at` (Unix milliseconds), `stream_path`, input/output formats and duplex/playback capabilities. Both audio directions currently use mono 16 kHz PCM signed 16-bit little-endian.

Voice settings writes validate the same voice configuration schema as startup, reject unknown fields, and merge nested `stt`, `tts`, `notes`, `turns` and `playback` overrides under a configuration write lock. They write only `agents[].voice` and preserve other agents and task settings. An empty new configuration stays disabled; enabling it requires selected speech models. Changes apply to new voice connections and subsequent replies; existing queued speech retains its pinned settings. Enabling Agent voice does not enable gateway orchestration. Browser clients do not need to save settings to register a URL. API keys are never accepted in this body. The catalog returns `{ provider, voices, models, warnings }`. Model entries include `can_do_text_to_speech`, `can_do_speech_to_text`, `realtime`, `voice_messages`, and optional `conversation` capabilities so clients can combine connected providers into role-specific model pickers. Scribe STT entries come from supported transport IDs (the ElevenLabs model endpoint lists synthesis models); Cartesia currently lists the adapter-supported Sonic 3 model. Paxa and Deepgram model inventories are fetched from their provider APIs; unavailable credentials/catalogs return `503` without upstream credentials.

The `upstream:elevenlabs` provider (`upstream` is a legacy alias) uses the origin of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (falling back to `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`), and the `/v1/voice/elevenlabs/` relay endpoints. It requires a provider service implementing this relay; an ordinary Anthropic-compatible messages endpoint alone is insufficient. The relay resolves the user's ElevenLabs BYOK connection. Direct `elevenlabs` configuration remains supported with `ELEVENLABS_API_KEY`.

Voice settings `language` is a recognition hint for STT. TTS follows the language of the approved spoken response, including typed messages while the microphone is muted. Model and voice catalog permissions are independent: a missing model-list permission returns usable voices and supported synthesis defaults marked `catalog_source: supported_defaults`, with a warning to enable `models_read` for the complete provider catalog.

After connecting, send JSON `{ "type": "voice.start", "voice_id": "<catalog-id>" }` (`voice_id` is optional). Wait for `voice.state` with `state: "listening"`, `generation`, `epoch` and `utterance_id` before sending microphone frames.

Binary audio uses a 44-byte header followed by PCM bytes: ASCII `CGV1` (4 bytes), generation UUID (16 bytes), epoch (uint32 big-endian), sequence (uint32 big-endian), segment UUID (16 bytes). Microphone segment IDs are the current utterance ID; playback frames identify the segment from `playback.start`. Reject stale generations/epochs. Payloads must have an even byte length and are bounded to 32,000 bytes per frame.

Client JSON controls:

| Type | Fields / behavior |
|---|---|
| `voice.configure` | `voice_id`; validated against the catalog, acknowledged by `voice.configured` |
| `speech.activity` | Signals current microphone speech activity |
| `speech.started` | `epoch`; signals a possible interruption |
| `speech.ended` | `last_audio_seq`; signals an utterance boundary |
| `utterance.commit` | `last_audio_seq`, optional `final: true`; finalize received audio |
| `voice.mute` | `muted` boolean, `policy: "commit"` or `"discard"`, `last_audio_seq`; commit pending input before muting or discard it |
| `playback.progress` | `epoch`, `sample_offset`; samples actually played, not merely received |
| `playback.clear.ack` | Acknowledge that queued audio was cleared |
| `voice.stop` | Close voice transport; does not cancel background tasks |

Server controls include `voice.state`, `voice.configured`, `stt.partial`, `stt.segment`, `stt.final`, `utterance.accepted`, `response.text`, `response.speech`, `playback.start`, `playback.end`, `playback.clear`, `voice.notice` and `voice.error`. Correlate chat/voice output using `response_id` and `request_id` when present; avoid rendering duplicate bubbles. Clear local queued audio on `playback.clear`. `SPEECH_SUMMARY_UNAVAILABLE` is a notice that approved spoken text is unavailable; retain the text response instead of reading the full report aloud.

If the STT provider connection ends unexpectedly, the gateway sends `voice.notice` with `reconnect: true` and `retryable: true`, then closes the WebSocket with code `1012`. Obtain a fresh ticket and reconnect with backoff; never reuse the consumed ticket. Committed conversation work continues. Audio from an unfinished utterance is not replayed automatically; the user may need to repeat it. Authentication, billing and other non-retryable errors remain `voice.error` and must not trigger an automatic retry loop.

Voice errors include a safe `message`, `category`, `retryable`, optional `httpStatus`, and `referenceId` alongside `code`. Preview generation failures return the same diagnostic fields plus `error`. The reference correlates with server logs; raw provider bodies and credentials are never returned. Payment/authentication/permission/quota errors require corrective action before retrying. Explicit rate-limit, network, timeout and temporary-unavailability errors permit a later retry; this flag does not automatically retry or resubmit audio. A bare HTTP 429 remains `quota_or_rate_limit` unless a recognized provider code distinguishes the cause. Unknown errors remain non-retryable diagnostics rather than guessed billing or model failures.


A connected, same-principal voice session can speak typed chat responses while its microphone is muted, including a task acknowledgement and the later worker result. The chosen voice remains the vocal identity. Spoken summaries follow the response language unless the user explicitly requests different chat/audio languages.


## PaxaLabs speech providers {#paxalabs-speech-providers}

Agent voice settings accept `paxalabs` (gateway environment key) and `upstream:paxalabs` (BYOK proxy under `ANTHROPIC_BASE_URL`) for `voice.tts.provider`, `voice.stt.provider`, and `voice.notes.provider`. Models are `paxa-tts-flash-v1` and `paxa-stt-lite-v1-preview`, respectively. `GET /api/v1/agents/:agentId/voice-settings` includes `direct_providers`, containing provider names only, never credentials.

The voice WebSocket `voice.state` listening event includes `stt_mode: "batch" | "realtime"`. In batch mode, `utterance.commit` (including microphone mute with commit policy) finalizes the recording and starts transcription; `stt.partial` is not emitted. Clients should display a transcribing state until the final transcript is available. Paxa accepts only `th`/`en` language hints; omission enables detection.


## Voice model catalog and preview {#voice-model-catalog-and-preview}

`GET /api/v1/agents/:agentId/voice-settings/catalog?provider=upstream:gemini` lists connected Gemini models and prebuilt voices. Gemini TTS uses generateContent; Gemini STT transcribes recorded segments after pause/mute (no live partials). Direct Gemini uses `GEMINI_API_KEY`; upstream Gemini reuses the pod provider credentials.

BYOK catalog IDs use `<provider>/<native-model>`, e.g. `gemini/gemini-3.1-flash-tts-preview`. Catalog entries include `native_model_id`, `provider`, `source` (`byok` or `gateway`), and `metered: false`. Legacy bare IDs still use their explicitly configured provider. A mismatched prefix is rejected. Managed catalogs use `getpod-voice/<provider>/<native-model>` with explicit `managed:<provider>` routing, `source: managed`, `metered: true`, and `credit_multiplier`. Missing BYOK credentials never switch payer.

`POST /api/v1/agents/:agentId/voice-settings/preview` requires agent write access. Body: `{ "provider": "upstream:gemini", "model": "gemini/gemini-3.1-flash-tts-preview", "voiceId": "Kore", "language": "en" }`. Preview language defaults to English. Supported codes: `ar`, `de`, `en`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `pt`, `ru`, `th`, `vi`, `zh`; PaxaLabs accepts only `en` and `th`. Returns `{ "mime": "audio/wav", "audio": "<base64>" }` for a short fixed preview, without saving settings or adding chat history. Generation uses the selected provider account.

## Retained speech replay

`GET /api/v1/agents/:agentId/sessions/:sessionId/voice-sessions/replays` returns `{response_ids: string[]}` for retained completed browser TTS recordings.

`GET /api/v1/agents/:agentId/sessions/:sessionId/voice-sessions/replays/:responseId` returns the original synthesized audio as `audio/wav`, or 404 if missing/expired. This GET never invokes a TTS provider. Both endpoints use API authentication, Agent access and conversation membership; no bearer credential belongs in the URL. Recordings are retained for at most 30 days with a 64 MiB per-Agent budget, oldest first eviction, and a 16 MiB per-recording limit. Disabling new voice synthesis does not delete existing recordings.


## Agent model selection in a voice connection

Voice clients may include `model` in `voice.start` and update it during the connection with `{ "type": "voice.configure", "model": "model-id" }`. The server acknowledges with `voice.configured`; subsequent utterance submissions use that model, including their new worker tasks. Existing running tasks retain their assigned model. This is the Agent model, independent of STT/TTS model selection.

## Provider credentials

Upstream voice uses the same Claude provider settings as the Agent: the `env` block in `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) takes precedence over inherited environment. Credentials are resolved as one group, so a settings identity cannot silently fall back to another exported token. Catalog, preview, STT and TTS resolve this connection when requested; a shell export is not required after restart. Model-catalog failures retain any available voices and report a provider diagnostic without changing saved selections.

## Automatic voice selection

When TTS `voiceId` is empty, Auto selects a voice from the configured provider's
catalog. An explicit session/chat choice takes precedence over the configured
voice. Auto keeps its choice for the gateway process and provider/account; after
restart it deterministically selects the lowest voice ID in the current catalog.
Catalog changes can therefore change Auto after a restart. Set a voice explicitly
to pin it across restarts. Catalog failures leave text chat available and report a
recoverable TTS error instead of preventing gateway startup.


## Managed voice wallet and startup recovery

The same reconnect protocol applies when opening the recognizer fails with a retryable provider error. Managed wallet checks honor cancellation and have a five-second timeout. Invalid or unavailable wallet responses produce `MANAGED_VOICE_USAGE_UNAVAILABLE`, not an exhausted-credit result.

Explicit `managed:elevenlabs` and `managed:paxalabs` routes use the authenticated provider service's `/v1/voice/managed/usage` wallet. Ticket creation returns `429` with `code: MANAGED_VOICE_QUOTA_EXHAUSTED` when that wallet is empty; if exhaustion happens after connection, the same code arrives in `voice.error` with `retryable: false`. Clients should pause voice until the wallet is replenished or reset, rather than retrying repeatedly. Channel voice-note transcription and synthesized replies quietly skip explicit managed exhaustion; text replies remain available. Saved voice preferences are unchanged, and the next request checks the current wallet again. Ordinary provider 429s and BYOK billing errors retain their normal diagnostics.
