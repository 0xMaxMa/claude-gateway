/**
 * Telegram `/call` Mini App: a live voice call with one agent, bound to the DM
 * the button was sent in. The page proves the Telegram user with signed initData
 * on every ticket request, then speaks the documented voice WebSocket protocol
 * (see website/api/voice.md). All URLs derive from `basePath`, the path of
 * `gateway.publicUrl`, and the WebSocket path comes from the ticket response.
 */
import { BASE_STYLE, TG_WEBAPP_JS, htmlEscape, page } from './cli-viewer-ui';
import { VOICE_CALL_PLAYBACK, VOICE_CALL_VAD, createResampler, createVoiceCallPlayback, createVoiceCallUplink, createVoiceCallVad, encodeVoiceCallFrame, formatCallDuration, voiceCallErrorView, voiceCallLevel, voiceCallReplyText, voiceCallTheme, voiceCallTicketFailure } from './voice-call-client';

export interface VoiceCallPageOpts {
  pairingId: string;
  agentId: string;
  basePath: string;
  /** `voice.turns.maxUtteranceMs`: the client ends a turn before the server would reject it. */
  maxUtteranceMs: number;
  /** The bot's Telegram name; the agent id when Telegram has not answered. */
  botName?: string;
  /** The agent has a Telegram bot, so the page asks for its photo. The photo covers the
   * name's initial, which shows when there is none. */
  photo?: boolean;
  /** The bot photo's Telegram `file_unique_id`, when known: it versions the photo URL. */
  avatarVersion?: string;
  /** The link already holds a call. Only the page holding its call token (a reload of
   * that call) rejoins; any other open shows the link as used and starts nothing. */
  linkUsed?: boolean;
}

/** The page's refusal for a link that was used, or that expired or never existed. */
export const VOICE_CALL_LINK_USED = voiceCallTicketFailure(409, { error: 'Call link already used', code: 'CALL_LINK_USED' }).message;
export const VOICE_CALL_LINK_EXPIRED = voiceCallTicketFailure(410, { error: 'Call link expired' }).message;

/** Collects ~40 ms of microphone samples per message at the context rate. */
const CAPTURE_WORKLET = `class VoiceCallCapture extends AudioWorkletProcessor {
  constructor(){ super(); this.size = Math.round(sampleRate * 0.04); this.buffer = new Float32Array(this.size); this.used = 0; }
  process(inputs){
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(this.size - this.used, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
      if (this.used === this.size) { this.port.postMessage(this.buffer.slice(0)); this.used = 0; }
    }
    return true;
  }
}
registerProcessor('voice-call-capture', VoiceCallCapture);`;

/**
 * Reply playback: one node for the whole call (see createVoiceCallPlayback). The
 * page posts `{ pcm }` frames and `{ flush: token }`; the node reports
 * `{ token, played, playing }` when playback starts or stops and every 100 ms of
 * audio (the page reports progress at that pace), so stale reports from before a flush are recognisable.
 */
const PLAYER_WORKLET = `${createVoiceCallPlayback.toString()}
class VoiceCallPlayer extends AudioWorkletProcessor {
  constructor(options){
    super(); this.player = createVoiceCallPlayback(sampleRate, options.processorOptions); this.token = 0; this.reported = 0; this.playing = false;
    this.step = Math.round(options.processorOptions.inputRate * 0.1);
    this.port.onmessage = event => { if (event.data.pcm) this.player.push(event.data.pcm); else { this.token = event.data.flush; this.player.flush(); this.report(); } };
  }
  report(){ this.reported = this.player.played(); this.playing = this.player.active(); this.port.postMessage({ token: this.token, played: this.reported, playing: this.playing }); }
  process(inputs, outputs){
    const out = outputs[0][0];
    if (out) this.player.render(out);
    const played = this.player.played(), playing = this.player.active();
    if (playing !== this.playing || played >= this.reported + this.step || (!playing && played !== this.reported)) this.report();
    return true;
  }
}
registerProcessor('voice-call-player', VoiceCallPlayer);`;

/**
 * Light and dark palettes. Telegram's theme colours lead where it gives them (it
 * sets `--tg-theme-*` on the page); the fallbacks serve a page outside Telegram.
 * The semantic colours keep their meaning in both: red ends or mutes, blue
 * listens, a brighter blue with a pulsing dot thinks, orange speaks.
 */
const STYLE = `${BASE_STYLE}
  :root { color-scheme: dark;
    --vc-bg: var(--tg-theme-bg-color, #0b0e14); --vc-text: var(--tg-theme-text-color, #e4e9ff); --vc-hint: var(--tg-theme-hint-color, #8f9bb3);
    --vc-surface: var(--tg-theme-secondary-bg-color, #232a3b); --vc-pressed: #e4e9ff; --vc-on-pressed: #0b0e14;
    --vc-button: #c3e88d; --vc-on-button: #0b0e14;
    --vc-listen: #82aaff; --vc-listen-ring: rgba(130,170,255,.35); --vc-listen-glow: rgba(130,170,255,.08); --vc-think: #4ade80;
    --vc-speak: #ffa94d; --vc-speak-ring: rgba(255,169,77,.75); --vc-speak-glow: rgba(255,169,77,.14); --vc-speak-halo: rgba(255,169,77,.06);
    --vc-muted: #ff8d95; --vc-end: #ff5c67; --vc-err: #ff757f; }
  :root[data-theme="light"] { color-scheme: light;
    --vc-bg: var(--tg-theme-bg-color, #ffffff); --vc-text: var(--tg-theme-text-color, #1c2333); --vc-hint: var(--tg-theme-hint-color, #6b7486);
    --vc-surface: var(--tg-theme-secondary-bg-color, #eef0f5); --vc-pressed: #1c2333; --vc-on-pressed: #ffffff;
    --vc-button: #23863f; --vc-on-button: #ffffff;
    --vc-listen: #2560c8; --vc-listen-ring: rgba(37,96,200,.45); --vc-listen-glow: rgba(37,96,200,.10); --vc-think: #13773a;
    --vc-speak: #a84b06; --vc-speak-ring: rgba(240,128,30,.80); --vc-speak-glow: rgba(240,128,30,.18); --vc-speak-halo: rgba(240,128,30,.07);
    --vc-muted: #c22631; --vc-end: #e5484d; --vc-err: #c4202b; }
  /* The call fills the Mini App and never grows past it: the transcript scrolls between a
   * fixed header and fixed controls. Telegram keeps --tg-viewport-stable-height current. */
  body { background: var(--vc-bg); color: var(--vc-text); overflow: hidden;
    height: 100vh; height: 100dvh; height: var(--tg-viewport-stable-height, 100dvh); }
  .muted { color: var(--vc-hint); }
  .err { color: var(--vc-err); }
  .call { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; align-items: center; text-align: center;
    padding: calc(48px + env(safe-area-inset-top)) 24px calc(28px + env(safe-area-inset-bottom)); }
  .head, .foot { flex: none; width: 100%; display: flex; flex-direction: column; align-items: center; }
  .call.gone { justify-content: center; }
  .avatar-wrap { position: relative; width: 132px; height: 132px; display: grid; place-items: center; }
  .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid transparent; transition: border-color .2s, box-shadow .2s; }
  .avatar { width: 112px; height: 112px; border-radius: 50%; display: grid; place-items: center; font-size: 46px; font-weight: 600; color: #fff;
    position: relative; background: linear-gradient(135deg, #8ea2ff 0%, #6b7cff 55%, #5a5fd8 100%); box-shadow: 0 8px 30px rgba(107,124,255,.25); }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
  .name { margin-top: 20px; font-size: 24px; font-weight: 600; color: var(--vc-text); word-break: break-word; }
  .timer { min-height: 22px; margin-top: 6px; font-size: 17px; color: var(--vc-hint); font-variant-numeric: tabular-nums; letter-spacing: .5px; }
  .chip { margin-top: 18px; max-width: 100%; display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 16px; background: var(--vc-surface); color: var(--vc-hint); }
  .chip .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .chip .bars { display: none; gap: 3px; align-items: center; height: 14px; }
  .chip .bars b { width: 3px; height: 14px; border-radius: 2px; background: currentColor; transform: scaleY(calc(var(--h) * (0.3 + 0.7 * var(--level, 0)))); transition: transform .1s linear; }
  .chip:has(.state.err) .dot { display: none; }
  .state { font-size: 14px; font-weight: 600; }
  .call.listening .ring { border-color: var(--vc-listen-ring); box-shadow: 0 0 0 8px var(--vc-listen-glow); }
  .call.listening .chip { color: var(--vc-listen); }
  .call.speaking .ring { border-color: var(--vc-speak-ring); box-shadow: 0 0 0 9px var(--vc-speak-glow), 0 0 0 20px var(--vc-speak-halo); }
  .call.speaking .chip { color: var(--vc-speak); }
  .call.speaking .dot { display: none; }
  .call.speaking .bars { display: inline-flex; }
  .call.thinking .chip { color: var(--vc-think); }
  .call.thinking .dot { animation: think 1s ease-in-out infinite alternate; }
  @keyframes think { from { opacity: .25; transform: scale(.7); } }
  .call.muted .chip { color: var(--vc-muted); }
  .lines { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; position: relative;
    margin: 28px 0 8px; padding-bottom: 20px; width: 100%; max-width: 340px;
    -webkit-mask-image: linear-gradient(#000 calc(100% - 20px), transparent); mask-image: linear-gradient(#000 calc(100% - 20px), transparent); }
  .line { min-height: 20px; font-size: 15px; line-height: 1.5; color: var(--vc-text); word-break: break-word; white-space: pre-line; }
  .you { color: var(--vc-listen); }
  .hint { margin: 12px 0 0; }
  .hint[hidden] { display: none; }
  button { font: inherit; font-size: 15px; border: 0; border-radius: 22px; padding: 11px 20px; cursor: pointer; color: var(--vc-on-button); background: var(--vc-button); }
  button:focus-visible { outline: 2px solid var(--vc-listen); outline-offset: 3px; }
  button[hidden], .controls[hidden] { display: none; }
  #start { margin-top: 14px; }
  .controls { margin-top: 22px; display: flex; gap: 30px; justify-content: center; }
  .ctl { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 12px; color: var(--vc-hint); }
  button.round { width: 66px; height: 66px; padding: 0; border-radius: 50%; display: grid; place-items: center; background: var(--vc-surface); color: var(--vc-text); }
  button.round svg { width: 28px; height: 28px; pointer-events: none; }
  button.round[aria-pressed="true"] { background: var(--vc-pressed); color: var(--vc-on-pressed); }
  button.round.end { background: var(--vc-end); color: #fff; }
  button.round .off { display: none; }
  /* Short screens (Telegram Desktop, small phones): a smaller header leaves the transcript room. */
  @media (max-height: 720px) {
    .call { padding-top: calc(20px + env(safe-area-inset-top)); padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
    .avatar-wrap { width: 96px; height: 96px; }
    .avatar { width: 80px; height: 80px; font-size: 34px; }
    .name { margin-top: 12px; font-size: 20px; }
    .chip { margin-top: 10px; }
    .lines { margin-top: 16px; }
    .controls { margin-top: 14px; }
    button.round { width: 60px; height: 60px; }
  }
  #speaker[aria-pressed="false"] .on, #mute[aria-pressed="true"] .on { display: none; }
  #speaker[aria-pressed="false"] .off, #mute[aria-pressed="true"] .off { display: block; }
`;

/** Sets the palette before the page paints and follows Telegram's (or the system's)
 * theme changes. Telegram's header and the area around the page take the page background. */
const THEME_SCRIPT = `<script>
  (function(){
    ${voiceCallTheme.toString()};
    var tg = window.Telegram && window.Telegram.WebApp, root = document.documentElement;
    var system = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    function apply(){
      var theme = voiceCallTheme(tg, Boolean(system && system.matches));
      root.setAttribute('data-theme', theme); root.style.colorScheme = theme;
      if (tg) { try { if (tg.setHeaderColor) tg.setHeaderColor('bg_color'); if (tg.setBackgroundColor) tg.setBackgroundColor('bg_color'); } catch (e) {} }
    }
    apply();
    if (tg && tg.onEvent) tg.onEvent('themeChanged', apply);
    if (system && system.addEventListener) system.addEventListener('change', apply);
  })();
  </script>`;

const icon = (cls: string, paths: string) => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SPEAKER = '<path d="M11 5L6 9H3v6h3l5 4V5z"/>';
const ICONS = {
  speakerOn: icon('on', `${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>`),
  speakerOff: icon('off', `${SPEAKER}<path d="M16 9l5 6M21 9l-5 6"/>`),
  mic: icon('on', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'),
  micOff: icon('off', '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.4 5.4"/><path d="M19 11a7 7 0 0 1-.4 2.3"/><path d="M12 18v3"/>'),
  end: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="transform: rotate(135deg)"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
};

export function generateVoiceCallPage(opts: VoiceCallPageOpts): string {
  const cfg = JSON.stringify({ pairingId: opts.pairingId, basePath: opts.basePath, maxUtteranceMs: opts.maxUtteranceMs, vad: VOICE_CALL_VAD, playback: VOICE_CALL_PLAYBACK, linkUsed: Boolean(opts.linkUsed) }).replace(/</g, '\\u003c');
  const client = [createResampler, encodeVoiceCallFrame, voiceCallLevel, createVoiceCallVad, createVoiceCallUplink, voiceCallTicketFailure, formatCallDuration, voiceCallErrorView, voiceCallReplyText].map(fn => fn.toString()).join(';\n');
  const name = opts.botName ?? opts.agentId;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  // Asked for even before the lookup answers: the photo route waits for it.
  const photo = opts.photo || opts.avatarVersion ? `${opts.basePath}/voice-call/${encodeURIComponent(opts.pairingId)}/avatar${opts.avatarVersion ? `?v=${encodeURIComponent(opts.avatarVersion)}` : ''}` : '';
  const used = Boolean(opts.linkUsed);
  const body = `${THEME_SCRIPT}
  <div class="call" id="call">
    <div class="head">
    <div class="avatar-wrap"><div class="ring"></div><div class="avatar" id="avatar" aria-hidden="true">${htmlEscape(initial)}${photo ? `<img id="photo" alt="" src="${htmlEscape(photo)}">` : ''}</div></div>
    <div class="name">${htmlEscape(name)}</div>
    <div class="timer" id="timer"></div>
    <div class="chip" role="status"><span class="dot"></span><span class="bars"><b style="--h:.45"></b><b style="--h:.85"></b><b style="--h:.65"></b><b style="--h:1"></b><b style="--h:.5"></b></span>${used ? `<span class="state err" id="state">${htmlEscape(VOICE_CALL_LINK_USED)}</span>` : '<span class="state" id="state">Starting…</span>'}</div>
    </div>
    <div class="lines" id="lines"><div class="line you" id="you"></div><div class="line" id="reply"></div></div>
    <div class="foot">
    <p class="muted hint" id="hint"${used ? ' hidden' : ''}>Your words and the replies also appear in the chat.</p>
    <button type="button" id="start" hidden>Start call</button>
    <div class="controls" id="controls" hidden>
      <div class="ctl"><button type="button" class="round" id="speaker" aria-label="Speaker" aria-pressed="true">${ICONS.speakerOn}${ICONS.speakerOff}</button><span aria-hidden="true">speaker</span></div>
      <div class="ctl"><button type="button" class="round end" id="hangup" aria-label="End call">${ICONS.end}</button><span aria-hidden="true">end</span></div>
      <div class="ctl"><button type="button" class="round" id="mute" aria-label="Mute" aria-pressed="false">${ICONS.mic}${ICONS.micOff}</button><span aria-hidden="true">mute</span></div>
    </div>
    </div>
  </div>
  <script>
  (function(){
    'use strict';
    var CFG = ${cfg};
    var WORKLET = ${JSON.stringify(CAPTURE_WORKLET + '\n' + PLAYER_WORKLET).replace(/</g, '\\u003c')};
    ${client};
    var tg = window.Telegram && window.Telegram.WebApp;
    var $ = function(id){ return document.getElementById(id); };
    var ctx, media, capture, ws, uplink, vad, resample, progressTimer, level, levelSamples, speaker;
    // Reply audio of this epoch: samples sent to the player, and the player's last report.
    // A flush starts a new token, so reports from before it are ignored.
    var player, playerToken = 0, pushedSamples = 0, playedSamples = 0, playing = false;
    var callToken, generation, epoch = 0, reportedPlayed = 0;
    var muted = false, paused = false, ended = false, attempts = 0, speakerOn = true, shownLevel, muteOnListening = false;
    // One connect at a time: a hide, show, hang-up or newer connect discards the pending one and its reconnect timer.
    var connecting = 0, reconnectTimer;
    // The user stopped speaking: show Thinking at once, through the gateway's commit and
    // merge window and the agent's turn, until it answers, reports no speech, or the user speaks again.
    var awaitingReply = false;
    // The call clock: set when a socket first listens, from the server's elapsed time
    // on a rejoin, so it keeps counting across reconnects like a phone call.
    var callStart, offeredElapsed = 0, joined = false;
    // The ring and chip follow the call: listening, thinking, the agent speaking, or muted.
    var SCENES = { Listening: 'listening', Thinking: 'thinking', Speaking: 'speaking', Muted: 'muted' };
    var scene;
    function state(text, tone){
      var s = $('state'); s.textContent = text; s.className = 'state' + (tone ? ' ' + tone : '');
      scene = !tone && SCENES[text] ? text : undefined;
      $('call').className = 'call' + (scene ? ' ' + SCENES[scene] : '');
    }
    // Speaking ends when the reply has played out and stayed quiet for QUIET_MS, longer than
    // the pause between its sentences. After an acknowledgement the answer is still coming.
    var QUIET_MS = 1000, playbackPhase, audioHeard = false, quietSince;
    function settlePlayback(){
      if (scene !== 'Speaking' || !audioHeard || playing) { quietSince = undefined; return; }
      if (quietSince === undefined) quietSince = Date.now();
      if (Date.now() - quietSince >= QUIET_MS) state(muted ? 'Muted' : awaitingReply || playbackPhase === 'acknowledgement' ? 'Thinking' : 'Listening');
    }
    // The transcript follows new text unless the caller scrolled up to read; scrolling
    // back down to where it was follows again. A reply opens at its first line, as it is
    // spoken; the caller's words show their latest.
    var follow = true, followTop = 0, lines = $('lines');
    lines.onscroll = function(){ if (lines.scrollTop < followTop - 2) follow = false; else { follow = true; followTop = lines.scrollTop; } };
    function show(id, text){
      var line = $(id); line.textContent = text;
      if (!follow) return;
      lines.scrollTop = id === 'reply' ? line.offsetTop : Math.max(0, line.offsetTop + line.offsetHeight - lines.clientHeight);
      followTop = lines.scrollTop;
    }
    function api(path){ return CFG.basePath + '/voice-call/' + CFG.pairingId + path; }
    function send(message){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(message)); }
    async function ticket(){
      var response = await fetch(api('/ticket'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ initData: tg.initData, call_token: callToken }) })
        .catch(function(){ var offline = new Error('The network is unavailable.'); offline.fatal = false; throw offline; });
      var body = await response.json().catch(function(){ return {}; });
      if (body.call_token) callToken = body.call_token;
      if (!response.ok) {
        var failure = voiceCallTicketFailure(response.status, body), error = new Error(failure.message);
        error.fatal = failure.fatal; error.signIn = failure.signIn;
        throw error;
      }
      return body;
    }
    function flushPlayback(){
      playerToken++; pushedSamples = 0; playedSamples = 0; playing = false; reportedPlayed = 0;
      if (player) player.port.postMessage({ flush: playerToken });
    }
    function playAudio(data){
      var view = new DataView(data);
      if (data.byteLength <= 44 || view.getUint32(20) !== epoch) return;
      var pcm = new Int16Array((data.byteLength - 44) >> 1);
      for (var i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(44 + i * 2, true);
      player.port.postMessage({ pcm: pcm }, [pcm.buffer]); pushedSamples += pcm.length; playing = true;
      // More of the reply after a pause that looked like its end.
      audioHeard = true; if (scene === 'Listening' || scene === 'Thinking') state('Speaking');
    }
    function reportProgress(){
      if (!ctx || !ws || ws.readyState !== 1) return;
      if (playedSamples > reportedPlayed) { reportedPlayed = playedSamples; send({ type: 'playback.progress', epoch: epoch, sample_offset: playedSamples }); }
    }
    function control(message){
      switch (message.type) {
        case 'voice.state':
          if (message.generation) generation = message.generation;
          if ((message.state === 'listening' || message.state === 'muted') && !joined) { joined = true; callStart = Date.now() - offeredElapsed; showDuration(); }
          if (message.state === 'listening') {
            attempts = 0; if (message.utterance_id) uplink.listening(message.utterance_id);
            // Words held for this utterance are sent now; muting then commits them.
            if (muteOnListening) { muteOnListening = false; sendMute(true); }
            if (!playing && !awaitingReply) state(muted ? 'Muted' : 'Listening');
          }
          if (message.state === 'muted') { uplink.reset(); awaitingReply = false; state('Muted'); }
          break;
        case 'stt.partial': case 'stt.segment': show('you', message.pending_text || message.text || ''); break;
        case 'stt.final': show('you', message.text); awaitingReply = true; state('Thinking'); break;
        case 'utterance.accepted': state('Thinking'); break;
        case 'response.text': if (message.text) show('reply', voiceCallReplyText(message.text)); break;
        case 'playback.start': epoch = message.epoch; flushPlayback(); awaitingReply = false; playbackPhase = message.phase; audioHeard = false; state('Speaking'); break;
        case 'playback.end': break;
        case 'playback.clear': epoch = message.epoch; flushPlayback(); send({ type: 'playback.clear.ack', epoch: epoch }); if (!awaitingReply) state(muted ? 'Muted' : 'Listening'); break;
        case 'voice.notice': if (message.reconnect) state('Reconnecting…'); break;
        case 'voice.error': {
          var view = voiceCallErrorView(message);
          awaitingReply = false;
          if (view.kind === 'ended') fail(new Error(view.message));
          else if (view.kind === 'listening') { show('you', ''); if (!playing) state(muted ? 'Muted' : 'Listening'); }
          else state(view.message, 'err');
          break;
        }
      }
    }
    async function connect(){
      var mine = ++connecting, issued;
      // A discarded connect neither opens a socket nor reports its failure.
      try { issued = await ticket(); } catch (error) { if (mine !== connecting) return; throw error; }
      if (mine !== connecting || ended || paused) return;
      offeredElapsed = typeof issued.call_elapsed_ms === 'number' ? issued.call_elapsed_ms : 0;
      var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var socket = new WebSocket(scheme + '//' + location.host + CFG.basePath + issued.stream_path + '?ticket=' + encodeURIComponent(issued.ticket));
      // A new socket starts with the page's mute state; nothing waits on the old utterance.
      ws = socket; joined = false; muteOnListening = false; awaitingReply = false;
      socket.binaryType = 'arraybuffer';
      socket.onopen = function(){ send({ type: 'voice.start', muted: muted }); };
      socket.onmessage = function(event){ if (socket !== ws) return; if (typeof event.data === 'string') control(JSON.parse(event.data)); else playAudio(event.data); };
      socket.onclose = function(event){
        // A socket replaced by a reconnect no longer owns the call state.
        if (socket !== ws) return;
        uplink.reset(); flushPlayback();
        if (ended || paused) return;
        // 1012: the recognizer restarted; 1006: the network dropped. Take a fresh ticket.
        if (event.code === 1012 || event.code === 1006) { reconnect(); return; }
        if (event.code === 1008) fail(new Error('Access changed. Send /call again.'));
        else { var lost = new Error('The call was disconnected.'); lost.fatal = false; fail(lost); }
      };
    }
    // A dropped socket's lease can take a moment to clear: retry transient ticket errors with backoff.
    function reconnect(){
      if (ended || paused) return;
      if (attempts >= 5) { var lost = new Error('The call was disconnected.'); lost.fatal = false; fail(lost); return; }
      attempts++; state('Reconnecting…');
      reconnectTimer = setTimeout(function(){ reconnectTimer = undefined; connect().catch(function(error){ if (error.fatal === false) reconnect(); else fail(error); }); }, 500 * attempts);
    }
    function cancelConnect(){ clearTimeout(reconnectTimer); reconnectTimer = undefined; connecting++; }
    function fail(error){
      state(error.message || 'The call could not continue.', 'err');
      if (error.signIn) {
        // Reloading lets the proxy redirect to its login page and back to this URL,
        // as the first open did; the fragment keeps Telegram's initData.
        hangup(true);
        var signIn = $('start'); signIn.textContent = 'Sign in again'; signIn.hidden = false;
        signIn.onclick = function(){ location.reload(); };
        return;
      }
      if (error.fatal !== false) { hangup(true); return; }
      // Keep the microphone grant; retry with the same call token.
      var retry = $('start'); retry.textContent = 'Retry'; retry.hidden = false;
      retry.onclick = function(){ retry.hidden = true; attempts = 0; state('Reconnecting…'); connect().catch(fail); };
    }
    // The speaking bars follow the agent's actual output level.
    function showLevel(){
      if (!level) return;
      level.getFloatTimeDomainData(levelSamples);
      var text = (playing ? Math.min(1, voiceCallLevel(levelSamples) * 5) : 0).toFixed(1);
      if (text !== shownLevel) { shownLevel = text; $('call').style.setProperty('--level', text); }
    }
    // A web page cannot choose the earpiece or the loudspeaker; Speaker turns the agent's voice on or off.
    function setSpeaker(on){
      speakerOn = on;
      if (speaker) speaker.gain.value = on ? 1 : 0;
      $('speaker').setAttribute('aria-pressed', String(on));
    }
    function showDuration(){
      if (callStart === undefined) return;
      var text = formatCallDuration(Date.now() - callStart), timer = $('timer');
      if (timer.textContent !== text) timer.textContent = text;
    }
    // Mute sends what was said: the open utterance is committed now and the agent answers it.
    function sendMute(value){
      var sequence = uplink.pendingSequence();
      send({ type: 'voice.mute', muted: value, policy: 'commit', last_audio_seq: value && sequence ? sequence : 0 });
      if (value) uplink.reset();
    }
    function setMuted(value){
      if (muted === value) return;
      muted = value; awaitingReply = false;
      // Words spoken while the last utterance commits are held for the next one: mute once they are sent.
      if (value && uplink.holding()) muteOnListening = true;
      else if (!value && muteOnListening) muteOnListening = false;
      else sendMute(value);
      if (!value) vad = createVoiceCallVad(CFG.vad);
      media.getAudioTracks().forEach(function(track){ track.enabled = !value; });
      $('mute').setAttribute('aria-pressed', String(value));
      state(value ? 'Muted' : 'Listening');
    }
    // A hidden Mini App cannot hear or be heard reliably (iOS cuts the mic). Leave the
    // call while hidden, so replies reach the chat as they would without a call, and
    // rejoin with the call token on return. Before the call is set up (the page waits
    // for the Start call tap) there is nothing to leave.
    function suspend(){
      if (!uplink || ended || paused) return;
      paused = true; cancelConnect(); uplink.reset(); flushPlayback();
      media.getAudioTracks().forEach(function(track){ track.enabled = false; });
      if (ws) { send({ type: 'voice.stop' }); ws.close(); }
      state('Paused');
    }
    function resume(){
      if (!paused || ended || document.visibilityState !== 'visible') return;
      paused = false; cancelConnect(); attempts = 0; vad = createVoiceCallVad(CFG.vad);
      media.getAudioTracks().forEach(function(track){ track.enabled = !muted; });
      state('Reconnecting…'); connect().catch(fail);
    }
    function hangup(silent){
      if (ended) return;
      showDuration(); ended = true; cancelConnect(); clearInterval(progressTimer);
      // hangup ends the call for the server too; a plain stop (the app hidden) may rejoin.
      send({ type: 'voice.stop', hangup: true }); if (ws) ws.close();
      if (media) media.getTracks().forEach(function(track){ track.stop(); });
      if (ctx) ctx.close().catch(function(){});
      if (tg && tg.disableClosingConfirmation) tg.disableClosingConfirmation();
      $('controls').hidden = true;
      if (!silent) { state('Call ended'); if (tg && tg.close) setTimeout(function(){ tg.close(); }, 600); }
    }
    // Telegram's Android WebView needs a tap before audio can play or be captured
    // (setMediaPlaybackRequiresUserGesture until the first touch); iOS does not.
    function askTap(){
      state('Tap Start call to begin.');
      var button = $('start'); button.textContent = 'Start call'; button.hidden = false;
      button.onclick = function(){ if (ctx) ctx.resume().catch(function(){}); start(true); };
    }
    // AudioContext.resume() stays pending while audio is blocked.
    function audioRunning(){
      return Promise.race([ctx.resume().catch(function(){}), new Promise(function(resolve){ setTimeout(resolve, 800); })])
        .then(function(){ return ctx.state === 'running'; });
    }
    // The page starts the call as it opens; gesture is a retry from the Start button.
    async function start(gesture){
      $('start').hidden = true;
      if (!tg || !tg.initData) { state('Open this page from the /call button in Telegram.', 'err'); return; }
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioWorkletNode) {
        state('This Telegram app cannot use the microphone here. Update Telegram or try another device.', 'err'); return;
      }
      state('Starting…');
      // The page proposes its call token, so a ticket response lost on the network can be retried.
      // It survives the reload of Sign in again, which would otherwise find its own link already used.
      var key = 'voice-call:' + CFG.pairingId;
      try { callToken = callToken || sessionStorage.getItem(key) || undefined; } catch (e) {}
      if (!callToken) callToken = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(32)), function(byte){ return ('0' + byte.toString(16)).slice(-2); }).join('');
      try { sessionStorage.setItem(key, callToken); } catch (e) {}
      try {
        // One microphone request per call: some Telegram clients prompt on every getUserMedia.
        if (!media) media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        // Only after the microphone: on iOS it switches the audio session to voice processing,
        // which can change the hardware rate under a context created before it (WebKit 221334).
        if (!ctx) {
          ctx = new AudioContext();
          var track = media.getAudioTracks()[0], settings = track && track.getSettings ? track.getSettings() : {};
          console.info('voice call audio: context ' + ctx.sampleRate + ' Hz, microphone ' + (settings.sampleRate || 'unknown') + ' Hz');
        }
      } catch (error) {
        if (!gesture) { askTap(); return; }
        state('Microphone access was denied.', 'err'); hangup(true); return;
      }
      if (!(await audioRunning())) { askTap(); return; }
      try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))); }
      catch (error) { state('This Telegram app cannot use the microphone here. Update Telegram or try another device.', 'err'); hangup(true); return; }
      resample = createResampler(ctx.sampleRate, 16000);
      vad = createVoiceCallVad(CFG.vad);
      var utteranceSamples = Math.floor(CFG.maxUtteranceMs * 16);
      uplink = createVoiceCallUplink({
        json: send,
        frame: function(utteranceId, sequence, pcm){ if (ws && ws.readyState === 1 && generation) ws.send(encodeVoiceCallFrame(generation, epoch, sequence, utteranceId, pcm)); },
      }, { preRollSamples: Math.ceil((CFG.vad.startMs + CFG.vad.endMs) * 16), maxHeldSamples: utteranceSamples, maxUtteranceSamples: utteranceSamples });
      capture = new AudioWorkletNode(ctx, 'voice-call-capture');
      var sink = ctx.createGain(); sink.gain.value = 0;
      ctx.createMediaStreamSource(media).connect(capture); capture.connect(sink); sink.connect(ctx.destination);
      capture.port.onmessage = function(event){
        if (muted || paused || ended) return;
        // Audible reply audio raises the bar for speech, so speaker echo does not interrupt it.
        var samples = event.data, edge = vad(voiceCallLevel(samples), samples.length / ctx.sampleRate * 1000, playing), pcm = resample(samples);
        if (edge === 'start') {
          uplink.speechStart({ playing: playing, epoch: epoch });
          if (awaitingReply) { awaitingReply = false; if (!playing) state('Listening'); }
        }
        uplink.audio(pcm);
        if (edge === 'end' && uplink.speechEnd() && !playing) { awaitingReply = true; state('Thinking'); }
      };
      if (!speaker) {
        level = ctx.createAnalyser(); level.fftSize = 512; levelSamples = new Float32Array(level.fftSize);
        speaker = ctx.createGain(); speaker.gain.value = speakerOn ? 1 : 0;
        level.connect(speaker); speaker.connect(ctx.destination);
        player = new AudioWorkletNode(ctx, 'voice-call-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: CFG.playback });
        player.port.onmessage = function(event){
          var report = event.data;
          if (report.token !== playerToken) return;
          playedSamples = Math.max(playedSamples, report.played);
          // Frames still on their way to the player count as playing.
          playing = report.playing || report.played < pushedSamples;
        };
        player.connect(level);
      }
      progressTimer = setInterval(function(){ reportProgress(); showDuration(); showLevel(); settlePlayback(); }, 100);
      if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
      $('controls').hidden = false;
      try { await connect(); } catch (error) { fail(error); }
    }
    if (tg) { try { tg.ready(); tg.expand(); if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); tg.onEvent && tg.onEvent('deactivated', suspend); tg.onEvent && tg.onEvent('activated', resume); } catch (e) {} }
    document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'hidden') suspend(); else if (!tg || tg.isActive !== false) resume(); });
    $('mute').onclick = function(){ setMuted(!muted); };
    $('speaker').onclick = function(){ setSpeaker(!speakerOn); };
    $('hangup').onclick = function(){ hangup(false); };
    // No photo (the bot has none, or Telegram could not be reached): the initial under it shows.
    var photo = $('photo');
    if (photo) { photo.onerror = function(){ photo.remove(); }; if (photo.complete && !photo.naturalWidth) photo.remove(); }
    // A used link opened from an old /call button stays as rendered: nothing starts.
    // The page holding its call token is a reload of that call, and rejoins it.
    var stored; try { stored = sessionStorage.getItem('voice-call:' + CFG.pairingId); } catch (e) {}
    if (CFG.linkUsed && !stored) {
      state(voiceCallTicketFailure(409, { error: 'Call link already used', code: 'CALL_LINK_USED' }).message, 'err');
      $('controls').hidden = true; $('start').hidden = true; $('hint').hidden = true;
      return;
    }
    $('hint').hidden = false;
    start(false);
  })();
  </script>`;
  return page('Voice call', STYLE, body, `<script src="${TG_WEBAPP_JS}"></script>`);
}

/** A link that expired or never existed: only how it ended, in the call screen's theme. */
export function generateVoiceCallGonePage(message: string): string {
  const body = `${THEME_SCRIPT}
  <div class="call gone"><div class="chip" role="status"><span class="state err">${htmlEscape(message)}</span></div></div>`;
  return page('Voice call', STYLE, body, `<script src="${TG_WEBAPP_JS}"></script>`);
}
