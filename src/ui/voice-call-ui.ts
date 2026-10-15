/**
 * Telegram `/call` Mini App: a live voice call with one agent, bound to the DM
 * the button was sent in. The page proves the Telegram user with signed initData
 * on every ticket request, then speaks the documented voice WebSocket protocol
 * (see website/api/voice.md). All URLs derive from `basePath`, the path of
 * `gateway.publicUrl`, and the WebSocket path comes from the ticket response.
 */
import { BASE_STYLE, TG_WEBAPP_JS, htmlEscape, page } from './cli-viewer-ui';
import { VOICE_CALL_VAD, createResampler, createVoiceCallPlayhead, createVoiceCallUplink, createVoiceCallVad, encodeVoiceCallFrame, voiceCallLevel } from './voice-call-client';

export interface VoiceCallPageOpts {
  pairingId: string;
  agentId: string;
  basePath: string;
  /** `voice.turns.maxUtteranceMs`: the client ends a turn before the server would reject it. */
  maxUtteranceMs: number;
}

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

const STYLE = `${BASE_STYLE}
  .call { gap: 14px; display: flex; flex-direction: column; align-items: center; }
  .state { font-size: 15px; font-weight: 600; margin-top: 4px; }
  .line { min-height: 20px; font-size: 14px; line-height: 1.5; color: #c8d3f5; word-break: break-word; }
  .you { color: #82aaff; }
  .row { display: flex; gap: 10px; justify-content: center; margin-top: 8px; }
  button { font: inherit; font-size: 15px; border: 0; border-radius: 22px; padding: 11px 20px; cursor: pointer; color: #0b0e14; background: #c3e88d; }
  button.secondary { background: #232a3b; color: #c8d3f5; }
  button.danger { background: #ff757f; }
  button[hidden] { display: none; }
`;

export function generateVoiceCallPage(opts: VoiceCallPageOpts): string {
  const cfg = JSON.stringify({ pairingId: opts.pairingId, basePath: opts.basePath, maxUtteranceMs: opts.maxUtteranceMs, vad: VOICE_CALL_VAD }).replace(/</g, '\\u003c');
  const client = [createResampler, encodeVoiceCallFrame, voiceCallLevel, createVoiceCallVad, createVoiceCallUplink, createVoiceCallPlayhead].map(fn => fn.toString()).join(';\n');
  const body = `
  <div class="center"><div class="card call">
    <h1>Voice call</h1>
    <p class="muted">Agent <span class="agent">${htmlEscape(opts.agentId)}</span></p>
    <div class="state" id="state">Ready</div>
    <div class="line you" id="you"></div>
    <div class="line" id="reply"></div>
    <p class="muted" id="hint">Your words and the replies also appear in the chat.</p>
    <div class="row">
      <button id="start">Start call</button>
      <button id="mute" class="secondary" hidden>Mute</button>
      <button id="hangup" class="danger" hidden>Hang up</button>
    </div>
  </div></div>
  <script>
  (function(){
    'use strict';
    var CFG = ${cfg};
    var WORKLET = ${JSON.stringify(CAPTURE_WORKLET).replace(/</g, '\\u003c')};
    ${client};
    var tg = window.Telegram && window.Telegram.WebApp;
    var $ = function(id){ return document.getElementById(id); };
    var ctx, media, capture, ws, uplink, vad, resample, progressTimer;
    var playhead = createVoiceCallPlayhead(), sources = [];
    var callToken, generation, epoch = 0, reportedPlayed = 0, stopRequest = 0, stopping = false;
    var muted = false, autoMuted = false, ended = false, attempts = 0;
    function state(text, tone){ var s = $('state'); s.textContent = text; s.className = 'state' + (tone ? ' ' + tone : ''); }
    function api(path){ return CFG.basePath + '/voice-call/' + CFG.pairingId + path; }
    function send(message){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(message)); }
    function ticketError(status, body){
      if (status === 401) return 'Telegram could not verify you. Reopen the call from the /call button.';
      if (status === 403) return 'You are not allowed to call this agent.';
      if (status === 409 && body.code === 'CALL_LINK_USED') return 'This call link was already used. Send /call again.';
      if (status === 409 && body.code === 'VOICE_DISABLED') return 'Voice calls are turned off for this agent.';
      if (status === 409) return 'A call is already open in this chat. Hang up there first.';
      if (status === 410 || status === 404) return 'This call link has expired. Send /call again.';
      if (status === 429) return 'Voice credit is exhausted.';
      return 'The call could not start right now. Please try again.';
    }
    async function ticket(){
      var response = await fetch(api('/ticket'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ initData: tg.initData, call_token: callToken }) })
        .catch(function(){ var offline = new Error('The network is unavailable.'); offline.fatal = false; throw offline; });
      var body = await response.json().catch(function(){ return {}; });
      if (body.call_token) callToken = body.call_token;
      if (!response.ok) {
        var error = new Error(ticketError(response.status, body));
        // A busy gateway or a lease still being released can succeed on retry.
        error.fatal = response.status !== 503 && !(response.status === 409 && !body.code);
        throw error;
      }
      return body;
    }
    function flushPlayback(){ sources.forEach(function(node){ try { node.stop(); } catch (e) {} }); sources = []; playhead.reset(); reportedPlayed = 0; }
    function playAudio(data){
      var view = new DataView(data);
      if (data.byteLength <= 44 || stopping || view.getUint32(20) !== epoch) return;
      var count = (data.byteLength - 44) / 2, buffer = ctx.createBuffer(1, count, 16000), channel = buffer.getChannelData(0);
      for (var i = 0; i < count; i++) channel[i] = view.getInt16(44 + i * 2, true) / 32768;
      var node = ctx.createBufferSource(); node.buffer = buffer; node.connect(ctx.destination);
      node.onended = function(){ sources = sources.filter(function(item){ return item !== node; }); };
      node.start(playhead.schedule(count, 16000, ctx.currentTime)); sources.push(node);
    }
    function reportProgress(){
      if (!ctx || !ws || ws.readyState !== 1) return;
      var played = playhead.played(16000, ctx.currentTime);
      if (played > reportedPlayed) { reportedPlayed = played; send({ type: 'playback.progress', epoch: epoch, sample_offset: played }); }
    }
    function control(message){
      switch (message.type) {
        case 'voice.state':
          if (message.generation) generation = message.generation;
          if (message.state === 'listening') { attempts = 0; if (message.utterance_id) uplink.listening(message.utterance_id); if (!sources.length) state(muted ? 'Muted' : 'Listening'); }
          if (message.state === 'muted') { uplink.reset(); state('Muted'); }
          break;
        case 'stt.partial': case 'stt.segment': $('you').textContent = message.pending_text || message.text || ''; break;
        case 'stt.final': $('you').textContent = message.text; state('Thinking'); break;
        case 'utterance.accepted': state('Thinking'); break;
        case 'response.text': if (message.text) $('reply').textContent = message.text; break;
        case 'playback.start': if (!stopping) { epoch = message.epoch; flushPlayback(); state('Speaking'); } break;
        case 'playback.end': break;
        case 'playback.clear': epoch = message.epoch; flushPlayback(); send({ type: 'playback.clear.ack', epoch: epoch }); state(muted ? 'Muted' : 'Listening'); break;
        case 'playback.stopped': epoch = message.epoch; stopping = false; flushPlayback(); break;
        case 'voice.notice': if (message.reconnect) state('Reconnecting…'); break;
        case 'voice.error': state(message.message || 'Voice error', 'err'); break;
      }
    }
    async function connect(){
      var issued = await ticket();
      var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(scheme + '//' + location.host + CFG.basePath + issued.stream_path + '?ticket=' + encodeURIComponent(issued.ticket));
      ws.binaryType = 'arraybuffer';
      ws.onopen = function(){ send({ type: 'voice.start', muted: muted }); };
      ws.onmessage = function(event){ if (typeof event.data === 'string') control(JSON.parse(event.data)); else playAudio(event.data); };
      ws.onclose = function(event){
        uplink.reset(); flushPlayback(); stopping = false;
        if (ended) return;
        // 1012: the recognizer restarted; 1006: the network dropped. Take a fresh ticket.
        if (event.code === 1012 || event.code === 1006) { reconnect(); return; }
        if (event.code === 1008) fail(new Error('Access changed. Send /call again.'));
        else { var lost = new Error('The call was disconnected.'); lost.fatal = false; fail(lost); }
      };
    }
    // A dropped socket's lease can take a moment to clear: retry transient ticket errors with backoff.
    function reconnect(){
      if (ended) return;
      if (attempts >= 5) { var lost = new Error('The call was disconnected.'); lost.fatal = false; fail(lost); return; }
      attempts++; state('Reconnecting…');
      setTimeout(function(){ connect().catch(function(error){ if (error.fatal === false) reconnect(); else fail(error); }); }, 500 * attempts);
    }
    function fail(error){
      state(error.message || 'The call could not continue.', 'err');
      if (error.fatal !== false) { hangup(true); return; }
      // Keep the microphone grant; retry with the same call token.
      var retry = $('start'); retry.textContent = 'Retry'; retry.hidden = false;
      retry.onclick = function(){ retry.hidden = true; attempts = 0; state('Reconnecting…'); connect().catch(fail); };
    }
    function setMuted(value){
      if (muted === value) return;
      muted = value;
      var sequence = uplink.pendingSequence();
      send({ type: 'voice.mute', muted: value, policy: 'commit', last_audio_seq: value && sequence ? sequence : 0 });
      if (value) uplink.reset(); else vad = createVoiceCallVad(CFG.vad);
      media.getAudioTracks().forEach(function(track){ track.enabled = !value; });
      $('mute').textContent = value ? 'Unmute' : 'Mute';
      state(value ? 'Muted' : 'Listening');
    }
    // A hidden Mini App cannot hear or be heard reliably (iOS cuts the mic): mute and drop queued audio.
    function suspend(){
      if (!media || ended) return;
      if (!muted) { autoMuted = true; setMuted(true); }
      if (playhead.playing(ctx.currentTime)) { stopping = true; send({ type: 'playback.stop', epoch: epoch, request_id: ++stopRequest }); }
      flushPlayback();
    }
    function resume(){ if (media && !ended && autoMuted && document.visibilityState === 'visible') { autoMuted = false; setMuted(false); } }
    function hangup(silent){
      if (ended) return;
      ended = true; clearInterval(progressTimer);
      send({ type: 'voice.stop' }); if (ws) ws.close();
      if (media) media.getTracks().forEach(function(track){ track.stop(); });
      if (ctx) ctx.close().catch(function(){});
      if (tg && tg.disableClosingConfirmation) tg.disableClosingConfirmation();
      $('mute').hidden = true; $('hangup').hidden = true;
      if (!silent) { state('Call ended'); if (tg && tg.close) setTimeout(function(){ tg.close(); }, 600); }
    }
    async function start(){
      $('start').hidden = true;
      if (!tg || !tg.initData) { state('Open this page from the /call button in Telegram.', 'err'); return; }
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioWorkletNode) {
        state('This Telegram app cannot use the microphone here. Update Telegram or try another device.', 'err'); return;
      }
      state('Starting…');
      try {
        ctx = new AudioContext();
        // One microphone request per call: some Telegram clients prompt on every getUserMedia.
        media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        await ctx.resume();
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
      } catch (error) { state('Microphone access was denied.', 'err'); hangup(true); return; }
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
        if (muted || ended) return;
        var samples = event.data, edge = vad(voiceCallLevel(samples), samples.length / ctx.sampleRate * 1000), pcm = resample(samples);
        if (edge === 'start') uplink.speechStart({ playing: playhead.playing(ctx.currentTime), epoch: epoch });
        uplink.audio(pcm);
        if (edge === 'end') uplink.speechEnd();
      };
      progressTimer = setInterval(reportProgress, 100);
      if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
      $('mute').hidden = false; $('hangup').hidden = false;
      try { await connect(); } catch (error) { fail(error); }
    }
    if (tg) { try { tg.ready(); tg.expand(); if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); tg.onEvent && tg.onEvent('deactivated', suspend); tg.onEvent && tg.onEvent('activated', resume); } catch (e) {} }
    document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'hidden') suspend(); else if (!tg || tg.isActive !== false) resume(); });
    $('start').onclick = function(){ start(); };
    $('mute').onclick = function(){ autoMuted = false; setMuted(!muted); };
    $('hangup').onclick = function(){ hangup(false); };
  })();
  </script>`;
  return page('Voice call', STYLE, body, `<script src="${TG_WEBAPP_JS}"></script>`);
}
