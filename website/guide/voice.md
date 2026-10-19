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

ElevenLabs v3 and v4 TTS models (`eleven_v3_conversational`, `eleven_v3`, `eleven_v4_turbo`, `eleven_v4`) stream through the Text-to-Dialogue socket; other models use the classic stream-input socket. Both sockets close after 20 seconds without input by default. While a reply's text stalls, the gateway keeps them open for up to 180 seconds: it sends `keep_alive` every 10 seconds on the dialogue socket, and it sets `inactivity_timeout` on the classic socket. `eleven_v4_turbo` has low first-audio latency; `eleven_v4` is slower and costs about twice as much per character, so it is not recommended for live conversation. A reply that contains known audio tags such as `[laughs]` or `[whispers]` is still spoken. The ElevenLabs v3/v4 models and Gemini 3.1 Flash TTS (`gemini-3.1-flash-tts-preview`, natively or through OpenRouter) receive the tags and perform them. Every other TTS model, including Gemini 2.5 TTS and Gemini 3.8 TTS (which documents `<angle>` tags instead), receives the text without them, so it never reads a tag aloud. A spoken text that holds only tags is not spoken. On a turn that is spoken, the chat copy omits the tags, both while it streams and in the final message. On a text-only turn the chat keeps them, since there a tag may be part of the answer.

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

OpenRouter and Gemini batch transcription use completed recorded segments, not realtime partial transcripts. Gemini browser STT instead uses the realtime adapter when the selected model is `gemini-3.5-transcribe-live`, and PaxaLabs browser STT uses its realtime adapter when the selected model is `paxa-stt-lite-realtime-v1-preview` (its batch models still use completed recorded segments); availability depends on provider access. A pause or microphone mute ends a segment before transcription begins. PaxaLabs live TTS requires `ffmpeg` for MP3 decoding.

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
| `paxalabs` | `PAXALABS_API_KEY` | Realtime with `paxa-stt-lite-realtime-v1-preview`; otherwise recorded segment | Recorded file | Supported; browser decoding needs ffmpeg |
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

## Long-form narration

A task worker can read text aloud in full with the `narrate` tool. Ask the agent, for example, to "read this page to me": the worker fetches the page, then passes the text (or a file path inside the task scope) to `narrate`. The tool never fetches URLs and never rewrites the text; it summarizes only if the worker is asked to summarize before calling it.

The gateway splits the text deterministically (paragraphs, then sentences, then words, then length) into pieces of about `targetChars`, synthesizes each piece with the chat's TTS voice, and stages `narration-NN-of-MM.mp3`. Because a worker can stage at most 10 files, longer texts are merged in order with `ffmpeg`. The files are delivered with the agent's next reply, after the task completes. Container workers cannot use `narrate`. Managed voice credit is checked before every piece; if it runs out, the pieces already produced are still delivered and the worker reports where it stopped.

Runs of symbols with nothing to pronounce (for example a line of `=` characters) are never sent to the TTS provider; they are merged into a neighbouring piece when it still fits one request, otherwise skipped, and the result reports `skipped_chars`. `NARRATE_EMPTY` means the text has nothing speakable at all. A call can run for a long time (up to `maxParts` × `partTimeoutMs`); the worker waits for it without the usual 5-minute response limit, capped at 2 hours overall. The files the call needs are reserved up front, so a parallel `narrate` or `task_stage_file` cannot take them while TTS credit is being spent; if too few of the 10 slots are free, the call fails with `TOO_MANY_ARTIFACTS` before any synthesis.

| Channel | How the audio arrives |
| --- | --- |
| Telegram | Audio messages (`sendAudio`) |
| WhatsApp Cloud | Audio messages |
| Discord, Slack | File attachments |
| LINE | Converted to AAC-LC M4A at delivery time (needs `ffmpeg` and `ffprobe`; 64 kbps mono, so 10 minutes measures about 4.9 MB against LINE's 5 MB cap) and sent as a playable audio message with its duration. A file longer than 10 minutes or larger than 5 MB cannot be sent: delivery fails with `LINE_AUDIO_TOO_LARGE` (the message states the measured size and the limit), `LINE_AUDIO_FFMPEG_UNAVAILABLE` when `ffmpeg`/`ffprobe` is missing, or `LINE_AUDIO_CONVERSION_FAILED` when ffmpeg cannot convert the audio. Converted files are removed after an hour |

| `voice.narrate` field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Allow the tool; it is always off while `voice.enabled` is `false` (the call then fails with `NARRATE_VOICE_DISABLED`) |
| `maxChars` | `100000` | Reject longer text (`NARRATE_TOO_LONG`); at most `2000000` |
| `maxParts` | `60` | Reject texts that split into more pieces (`NARRATE_TOO_LONG`); at most `200` |
| `targetChars` | `800` | Soft size of one piece; at most `4000` |
| `partTimeoutMs` | `60000` | Timeout of one TTS call; at most `300000` |

## Turn timing and playback settings

| Setting under `voice` | Default | Meaning |
| --- | --- | --- |
| `language` | empty | Recognition language hint; empty allows automatic recognition |
| `turns.silenceCommitMs` | 650 ms | Pause after the client's `speech.ended` before committing a microphone segment; `0` commits at once (the `/call` page already waits 350 ms of silence before it sends `speech.ended`) |
| `turns.finalizationTimeoutMs` | 5000 ms | Base finalization budget; batch providers may require a longer provider-specific budget |
| `turns.maxUtteranceMs` | 60000 ms | Bound a single utterance |
| `turns.mergeWindowMs` | 2000 ms | After a segment is committed, wait this long for a continuation before submitting the combined turn; `0` submits each segment at once |
| `playback.maxBufferedAudioMs` | 1500 ms | Bound unacknowledged playback audio |
| `playback.bargeIn` | true | Allow speech interruption behavior |
| `maxActiveSessionsPerConversation` | 1 | Limit concurrent live voice connections for a conversation |

A shorter pause commits sooner and may cut a natural pause into separate segments; a longer pause waits for more speech but delays submission. The merge window is the larger of the two waits: every turn waits the full `mergeWindowMs` after its transcript before the agent starts. The default is 2000 ms, so a hesitation of up to about two seconds in the middle of a thought stays in the same turn. Lowering it, for example to 1200 ms (the previous default), answers about 800 ms sooner, but a pause longer than the window becomes its own turn: the earlier part is answered, then interrupted by the continuation. When that happens, the next turn receives the interrupted parts from the last minute as context, and the agent answers the latest part first. Set `voice.turns.mergeWindowMs` per agent to trade one for the other, and remove the setting to go back. The spoken reply answers the latest question first and covers each question the chat reply answers; when the chat reply answers a distinctive term from the user's words (such as `npm` in a Thai sentence) that the spoken reply leaves out, the conversation records a `response.speech_coverage_gap` event. This is separate from orchestration's `intakeWaitMs`, which combines already received incomplete inputs. The setting is not a promise of end-to-end reply latency.

## Live call latency settings

These settings under `voice.live` change only live voice turns (`/call` and browser live voice). `fastAck` is on by default: the reply's first audio usually takes several seconds, and the acknowledgement fills that silence at the cost of one extra `fastAckModel` request per live turn. Set `voice.live.fastAck` to `false` for an agent to turn it off. If the request fails or times out, the turn continues without an acknowledgement and the reply is not delayed.

> **Upgrade note:** `fastAck` used to default to `false`, and saving voice settings could write that default into an agent's config. Upgrading to configVersion 1.0.37 removes `voice.live.fastAck: false` from every agent once, so those agents use the new default, and logs a warning. A `false` set before 1.0.37 is removed too, because it cannot be told apart from the old default; set it again to keep fast acknowledgements off. A `false` set at 1.0.37 or later is kept. `PATCH /api/v1/agents/:agentId/voice-settings` now saves only the `live` and `narrate` values that differ from the agent's current settings, merged into the values already saved.

| Setting under `voice.live` | Default | Effect |
| --- | --- | --- |
| `fastAck` | `true` | When the reply has not started speaking `fastAckAfterMs` after the turn is admitted, speak one short acknowledgement (for example "รับทราบค่ะ กำลังเช็คให้นะคะ") written by `fastAckModel` from the caller's words and the voice's gender. The model is asked for at most 8 words and never to answer; a phrase longer than 80 characters or with a line break, a number, a link or markup is dropped, and greetings or small talk get none. The request starts as each turn is admitted, so every live turn sends one `fastAckModel` request; it is cancelled, or its acknowledgement discarded, when the reply starts speaking first. It is audio only; it is not added to the chat, the history or memory. The call uses the agent's own model endpoint and credential (the `ANTHROPIC_BASE_URL` group the Claude CLI uses); a subscription token is only sent through a proxy, never straight to Anthropic. Each call is logged as `Voice fast ack` with its outcome, elapsed time and token counts, never the text. |
| `fastAckModel` | `claude-haiku-5-5` | Model for the acknowledgement, called with thinking disabled |
| `fastAckAfterMs` | `1500` | How long after admission the reply may take to start speaking before the acknowledgement plays |
| `fastAckTimeoutMs` | `3000` | Give up on an acknowledgement that takes longer |

## Diagnose missing or delayed audio

Start with the text result, the selected route and the error reference. Authentication failures, exhausted quota and temporary provider unavailability require different actions; switching voices does not fix a missing API key or exhausted quota. Auto voice selection requires a readable voice catalog. For a catalog failure, check credentials/model access instead of overwriting the saved selection with an invented voice.

Live voice logs `Voice timing` events with operation `stt`, `tts` or `turn`, an operation ID, session identifiers, the `utteranceId`, `inputId` and `responseId` known so far, and phase timestamps. Subtract elapsed times between phases:

1. `speech_ready` → `synthesis_started`: queue wait before TTS.
2. `provider_request_started` → `provider_headers_received`: HTTP provider/proxy wait.
3. `provider_body_received` → `first_provider_audio`: complete-body processing for the Gemini adapter.
4. `first_audio_sent` → `first_playback_progress`: first positive browser playback receipt.

A `turn` operation follows one user turn end to end, measured at the gateway: `speech_ended` (the client's `speech.ended` arrived; an explicit commit without it logs `commit_received`), `transcript_ready`, `turn_admitted`, `agent_first_spoken` (the agent's first approved spoken text) and `e2e_first_audio` (the first playback receipt for that reply). The `e2e_first_audio` elapsed time is the gateway's view of end of speech to first heard audio; it excludes microphone and network time before `speech.ended` arrives.

The agent turn between `turn_admitted` and `agent_first_spoken` reports its own phases on the same `turn` operation: `process_spawned` (the agent CLI process is ready for the prompt, spawned or resumed), `first_model_token` (the first reply text or response-argument chunk), `agent_provider_ready` (the model provider answered), `first_spoken_delta` (the first characters of `spoken_text` in the streamed response), each `spoken_sentence_sent` (a piece of spoken text handed to TTS) and, when fast acknowledgements are on, `fast_ack_sent`. A `tts` operation on a managed provider logs `tts_credit_check_started` and `tts_credit_check_finished` around the wallet check, and the ElevenLabs adapter logs `tts_socket_open` when its streaming socket is connected.

HTTP phases apply to adapters using the shared HTTP helper. They do not identify whether an upstream wait is internal queueing or work inside the final provider; that needs upstream diagnostics. A playback receipt is not an exact audio-device start timestamp. `audio_sent_complete` includes browser backpressure, so it must not be used as time to first sound.

The current Gemini adapter waits for the full provider JSON/audio result before yielding transport chunks. This explains why text can arrive well before audio. It describes the gateway implementation, not a universal restriction of the Gemini service. The gateway does not automatically retry a failed synthesis and risk duplicate or overlapping audio.

The diagnostic payload contains metadata, not transcript text, audio, URLs or provider credentials. See [voice API](../api/voice.md) for error fields, ticket authentication, replay and client reconnect behavior. Static `allowedOrigins` configuration is obsolete; live voice uses authenticated tickets bound to the initiating origin.


## Telegram voice calls

With orchestration serving Telegram, voice enabled and an HTTPS `gateway.publicUrl`, a paired user can send `/call` in the bot's private chat to talk with the agent live. The call uses the same STT, TTS and turn settings as browser live voice, and speaks with the voice chosen by `/voices` in that chat (the same voice as its voice messages), or the configured `voice.tts.voiceId` (Auto when empty) if the chat has not chosen one. A voice chosen during a call applies from the next call. It joins the chat's active session, and posts the user's words (`🎙 …`) and the agent's text replies in that chat. Tool permissions follow the Telegram channel (`allow_tools`); live voice never writes memory. Behind a proxy with its own sign-in, such as a GetPod pod, the call page uses the same login redirect as `/cli`. In a call, **Mute** sends what you just said: the agent answers at once instead of waiting for a pause, and keeps speaking while your microphone is off. Speaking while the agent's reply is still playing interrupts it, and your new words become the next turn. The page shows **Thinking** from when you stop speaking until the reply plays; the agent receives the turn after `voice.turns.silenceCommitMs`, transcription, and `voice.turns.mergeWindowMs` (a continuation within that window joins the same turn). A call link opens one call: an older or expired link renders only its ended state, and the page follows Telegram's light or dark theme. See [Telegram setup](../channels/telegram.md#live-voice-calls).

## Managed voice credits

Select `managed:elevenlabs` or `managed:paxalabs` with a model from the authenticated provider service’s managed catalog. These routes use its daily voice wallet; direct providers and `upstream:<provider>` BYOK routes keep their own billing. There is no automatic switch between payers.

When managed credits run out, text chat remains available and the channel says why voice stopped. The notices are fixed English text on every channel (Telegram, Discord, LINE and Slack), whatever the chat, agent or voice language. The gateway sends them directly; the agent never writes or translates them. A voice note gets `Voice credit is used up, so this voice message could not be transcribed. Please type your message instead. Reference: <inputId>`. A voice reply is replaced by its text, followed by `Voice reply unavailable: voice credit is used up. Text replies continue until the credit resets or is topped up, or use /voice off.` Each chat gets at most one notice of each kind per hour, also across new sessions. The notice is recorded in the agent state, so a restart does not repeat it. When managed voice works again anywhere on the agent (a voice note is transcribed or a voice reply is delivered), every chat's notices reset, because they share one wallet. A notice that could not be sent does not count. Later voice notes in that hour end without a reply. Saved voice preferences stay unchanged; a subsequent request checks the wallet again after reset. Browser clients should pause voice on `MANAGED_VOICE_QUOTA_EXHAUSTED` until credits become available. A wallet check that cannot finish is retried briefly and then does not block the request, because only a definite empty wallet stops voice work. See the [Voice API](../api/voice.md#managed-voice-wallet-and-startup-recovery).

## Voice-message failures and retry

Voice-message transcription retries a provider timeout, connection failure, server error (5xx/408) or plain rate limit (429) twice, after 1 s and 3 s, within two minutes in total. Authentication, payment, quota, format, size and empty-speech failures are final and are not retried.

The recording is kept. If transcription still fails for a reason a retry can fix (provider, connection, timeout, rate limit, credit check, or a run cut off by a gateway restart), the failure reply in a private Telegram chat carries a **🔁 Retry** button. It transcribes the same stored recording again, as a new voice message from the same sender in the same chat, and the agent answers it with the conversation's current model, as usual. Only that sender can use it, within 24 hours, and only once per failure. A note that was already transcribed is never processed again. Final failures have no button. Each failure, retry attempt and incomplete credit check is written to the agent's log (`<logDir>/<agent>.log`) with the reply's reference ID, the code, the HTTP status and the elapsed time. API keys and provider message bodies are not logged.

## Local audio dependencies

Install `ffmpeg` and `ffprobe` in the environment running the gateway for encoded
streaming audio and channel conversions. A working ElevenLabs preview does not
prove these tools are installed. Run `claude-gateway doctor`; use
`claude-gateway doctor fix` for explicit supported installation/repair. See
[voice dependency troubleshooting](./troubleshooting.md#voice-works-with-one-provider-but-fails-with-another).

### Speaking over a response

Speaking again during a live voice response interrupts its playback and inference.
The gateway keeps any reply text already shown, without inserting a “Response stopped.”
message into chat history. Your next utterance starts the next turn. Explicit Stop
commands keep their confirmation behavior; interrupting a reply does not cancel background tasks.
