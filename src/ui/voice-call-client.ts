/**
 * Pure browser logic for the Telegram `/call` page. Each function is
 * self-contained so the page can embed it with `Function.toString()` (as the
 * dashboard does) while tests import the same code.
 */

/** Client acoustic tuning for endpointing. These are microphone-level heuristics,
 * not protocol timing: the server still waits `voice.turns.silenceCommitMs`
 * after `speech.ended` before it commits an utterance. Levels are RMS of
 * float samples in [-1, 1]. */
export const VOICE_CALL_VAD = { startMs: 120, endMs: 350, ratio: 3, minLevel: 0.012, initialNoise: 0.004, noiseAdapt: 0.05 };

/**
 * Streaming resampler from the AudioContext rate to 16 kHz PCM16. A one-pole
 * low-pass at the output Nyquist frequency limits aliasing; linear interpolation
 * carries the fractional position and last sample across chunks.
 */
export function createResampler(inputRate: number, outputRate: number): (input: Float32Array) => Int16Array {
  const step = inputRate / outputRate;
  const alpha = 1 - Math.exp(-2 * Math.PI * (outputRate / 2) / inputRate);
  let position = 0, previous = 0, filtered = 0;
  return input => {
    const smooth = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) { filtered += alpha * (input[i] - filtered); smooth[i] = filtered; }
    const out: number[] = [];
    // `position` is relative to this chunk; -1 is the previous chunk's last sample.
    while (position < smooth.length - 1) {
      const index = Math.floor(position), fraction = position - index;
      const a = index < 0 ? previous : smooth[index], b = smooth[index + 1];
      const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      out.push(value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff));
      position += step;
    }
    if (smooth.length) { position -= smooth.length; previous = smooth[smooth.length - 1]; }
    return Int16Array.from(out);
  };
}

/** One `CGV1` microphone frame: 44-byte header, then little-endian PCM16. */
export function encodeVoiceCallFrame(generation: string, epoch: number, sequence: number, segmentId: string, pcm: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2), view = new DataView(buffer);
  'CGV1'.split('').forEach((character, index) => view.setUint8(index, character.charCodeAt(0)));
  const uuid = (value: string, offset: number) => {
    const hex = value.replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('INVALID_FRAME_ID');
    for (let i = 0; i < 16; i++) view.setUint8(offset + i, parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  };
  uuid(generation, 4); view.setUint32(20, epoch >>> 0, false); view.setUint32(24, sequence >>> 0, false); uuid(segmentId, 28);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return buffer;
}

/** RMS level of a float chunk. */
export function voiceCallLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Energy endpointing with an adaptive noise floor. Feed one level per chunk with
 * its duration; it reports `start` after `startMs` above the threshold and `end`
 * after `endMs` below it. The floor only learns from non-speech chunks.
 */
export function createVoiceCallVad(options: { startMs: number; endMs: number; ratio: number; minLevel: number; initialNoise: number; noiseAdapt: number }): (level: number, ms: number) => 'start' | 'end' | undefined {
  let noise = options.initialNoise, speaking = false, above = 0, below = 0;
  return (level, ms) => {
    const loud = level > Math.max(options.minLevel, noise * options.ratio);
    if (!speaking) {
      if (loud) { above += ms; if (above >= options.startMs) { speaking = true; below = 0; return 'start'; } }
      else { above = 0; noise += (level - noise) * options.noiseAdapt; }
      return undefined;
    }
    if (loud) { below = 0; return undefined; }
    below += ms;
    if (below >= options.endMs) { speaking = false; above = 0; return 'end'; }
    return undefined;
  };
}

/**
 * Microphone uplink for one call. The server accepts frames only for the current
 * `utterance_id`, with sequences 1, 2, 3…, and `speech.ended` must name the last
 * sequence sent. After `speech.ended` the next words wait for a new `listening`
 * state, so audio captured meanwhile is held (bounded) and sent first.
 */
export function createVoiceCallUplink(io: { json(message: Record<string, unknown>): void; frame(utteranceId: string, sequence: number, pcm: Int16Array): void },
  limits: { preRollSamples: number; maxHeldSamples: number; maxUtteranceSamples: number }) {
  let utteranceId: string | undefined, sequence = 0, sentSamples = 0;
  let state: 'waiting' | 'ready' | 'speaking' | 'ended' = 'waiting';
  let held: Int16Array[] = [], heldSamples = 0, speechPending = false, endPending = false, endedSequence = 0;
  const hold = (pcm: Int16Array, cap: number) => {
    held.push(pcm); heldSamples += pcm.length;
    while (held.length > 1 && heldSamples - held[0].length >= cap) heldSamples -= held.shift()!.length;
  };
  const send = (pcm: Int16Array) => {
    if (!utteranceId || !pcm.length) return;
    // Stay under the utterance budget: end the turn rather than overrun it.
    if (sentSamples + pcm.length > limits.maxUtteranceSamples) { end(); return; }
    sequence++; sentSamples += pcm.length; io.frame(utteranceId, sequence, pcm);
  };
  const begin = () => {
    state = 'speaking'; sequence = 0; sentSamples = 0;
    const queued = held; held = []; heldSamples = 0;
    for (const pcm of queued) if (state === 'speaking') send(pcm);
  };
  const end = () => {
    if (state !== 'speaking') return;
    if (sequence) { io.json({ type: 'speech.ended', last_audio_seq: sequence }); state = 'ended'; endedSequence = sequence; }
    else state = 'ready';
    utteranceId = state === 'ended' ? undefined : utteranceId;
  };
  return {
    /** The server opened a new utterance. */
    listening(id: string) {
      utteranceId = id; state = 'ready'; endedSequence = 0;
      if (speechPending) { speechPending = false; begin(); if (endPending) { endPending = false; end(); } }
    },
    /** The microphone is closed server-side (muted or reconnecting). */
    reset() { utteranceId = undefined; state = 'waiting'; held = []; heldSamples = 0; speechPending = false; endPending = false; endedSequence = 0; },
    audio(pcm: Int16Array) {
      if (state === 'speaking') send(pcm);
      else hold(pcm, speechPending ? limits.maxHeldSamples : limits.preRollSamples);
    },
    /** VAD start. A newer epoch interrupts audible playback; otherwise only defer admission. */
    speechStart(playback: { playing: boolean; epoch: number }) {
      io.json(playback.playing ? { type: 'speech.started', epoch: playback.epoch + 1 } : { type: 'speech.activity' });
      if (state === 'ready') begin(); else if (state !== 'speaking') { speechPending = true; endPending = false; }
    },
    speechEnd() { if (state === 'speaking') end(); else if (speechPending) endPending = true; },
    /** `last_audio_seq` for a commit-on-mute: the utterance still open on the server, if any. */
    pendingSequence(): number | undefined { return state === 'speaking' && sequence ? sequence : state === 'ended' ? endedSequence : undefined; },
  };
}

/**
 * Played-sample accounting for one playback epoch. Audio is scheduled back to
 * back; whatever is still scheduled after `now` has not been heard yet.
 */
export function createVoiceCallPlayhead() {
  let queuedSamples = 0, endTime = 0, reported = 0;
  return {
    reset() { queuedSamples = 0; endTime = 0; reported = 0; },
    /** Returns the context time at which this chunk starts. */
    schedule(samples: number, sampleRate: number, now: number): number {
      const start = Math.max(now, endTime);
      endTime = start + samples / sampleRate; queuedSamples += samples;
      return start;
    },
    /** Samples heard so far, monotonic and never above what was received. */
    played(sampleRate: number, now: number): number {
      const remaining = Math.max(0, Math.ceil((endTime - now) * sampleRate));
      reported = Math.max(reported, Math.min(queuedSamples, queuedSamples - remaining));
      return reported;
    },
    playing(now: number): boolean { return endTime > now; },
  };
}
