# Voice

::: warning Unreleased · PR #465
This page describes [PR #465](https://github.com/0xMaxMa/claude-gateway/pull/465), **not main or the published feature set**. Evaluate it with the matching preview source. Provider catalogs and model availability are resolved at runtime.
:::

## Configure one agent

Voice requires gateway orchestration and per-agent `voice.enabled: true`. The `voice` object belongs directly in the agent entry beside `id`, not inside `orchestration`. New agents start with voice disabled.

| Agent voice field | Purpose |
| --- | --- |
| `stt` | Browser microphone transcription |
| `notes` | Uploaded voice-message transcription; `notes.enabled` enables input |
| `tts` | Spoken responses |
| `notes.replyWithVoice` | Whether channel speech replies are permitted |

Configure provider, model, and voice selections before enabling. Keep credentials in environment variables or the connected upstream provider. The following example IDs come from the PR implementation; confirm their availability in your connected account's current catalog.

## Choose a connection

### Direct ElevenLabs example

In the preview gateway's `~/.claude-gateway/.env`, add your own credential:

```dotenv
ELEVENLABS_API_KEY=YOUR_ELEVENLABS_API_KEY
```

Restart after changing this global environment file; configuration hot reload does not reload it. Existing shell/service environment values take precedence. Direct provider credentials belong to the gateway process.

Merge this **partial preview configuration** into your existing configuration. Retain the agent's workspace, model, channels, and other required fields; replace `assistant` with its existing ID:

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

For current implementation details, see [PR #465's provider configuration changes](https://github.com/0xMaxMa/claude-gateway/pull/465/files). No provider API key is sent to the browser. Gemini and PaxaLabs also support direct and upstream modes; use their catalog entries for model selection.

## Verify in stages

1. Select a model and voice from the available catalog and play a preview. Previewing does not change saved agent settings.
2. Enable the agent's voice settings and test a short browser recording. Confirm the transcript before evaluating the response.
3. In a paired Telegram private chat, use `/voice` to select **Always**, **Only reply voice message**, or **Off**. Each chat starts **Off**, independently of the agent capability.
4. Use `/voices` to select a voice, send a short message, and verify both text and audio. Telegram speech follows confirmed text delivery.

Voice replies and controls cover Telegram, Discord, LINE, and Slack in the preview. Unsupported channels return a notice. Per-chat choices persist across session switches and restarts; browser voice choices are independent.

## Recorded input and replay

Gemini and PaxaLabs transcription use completed recorded segments, not realtime partial transcripts. A pause or microphone mute ends a segment before transcription begins. PaxaLabs live TTS requires `ffmpeg` for MP3 decoding.

Completed browser TTS recordings can be replayed without another provider request. The speaker button appears only when a recording was retained. Retention is up to 30 days with a 64 MiB budget per agent and a 16 MiB per-recording limit; interrupted synthesis is not offered as a completed recording.

If speech is missing, check agent enablement, orchestration, provider/model selection, `notes.replyWithVoice`, and the chat's `/voice` preference in that order. Long reports, code, and URLs are not automatically read as a fallback for missing structured speech.
