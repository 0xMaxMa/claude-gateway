#!/usr/bin/env node
// Paid, bounded provider smoke: two short TTS requests, one file STT, one voice turn.
// npm run build && node scripts/orchestration/smoke-elevenlabs.cjs /path/to/elevenlabs.env [voice-id]
// Uses a synthetic summary fixture; does not run agent inference or test hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { ElevenLabsTts } = require('../../dist/voice/providers/elevenlabs-tts');
const { ElevenLabsStt } = require('../../dist/voice/providers/elevenlabs-stt');
const { transcribeVoiceNote } = require('../../dist/voice/notes');
const { VoiceSession } = require('../../dist/voice/session');
const { decodeVoiceFrame } = require('../../dist/voice/protocol');
const { splitSpeechResponse } = require('../../dist/orchestration/speech');
const { PCM16 } = require('../../dist/voice/types');
const voiceSurfaces = {
  display: 'ตัวอย่างผลทดสอบ: แก้ฟังก์ชันจากลบเป็นบวกสำเร็จ และทดสอบผ่านแล้ว รายละเอียดนี้เป็นข้อมูลจำลองสำหรับตรวจการสรุปเสียงเท่านั้น '.repeat(4),
  spoken: 'ทดสอบสำเร็จแล้ว แก้ฟังก์ชันจากลบเป็นบวก และรันเทสต์ผ่านครับ',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function wav(pcm) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
(async () => {
  if (process.argv[2]) process.loadEnvFile(process.argv[2]);
  const key = process.env.ELEVENLABS_API_KEY; assert(key, 'ELEVENLABS_API_KEY required');
  const voiceId = process.argv[3] || 'JBFqnCBsd6RMkjVDRZzb';
  const root = fs.mkdtempSync(join(tmpdir(), 'orchestration-elevenlabs-'));
  const report = { date: new Date().toISOString(), voiceId, root, pass: false,
    limits: ['Synthetic microphone; no hardware, echo or platform-account delivery tested.', 'Synthetic summary fixture, not a fresh agent inference.', 'No quota exhaustion or outage injected.'] };
  let session;
  const watchdog = setTimeout(() => { console.error('SMOKE_DEADLINE'); process.exit(1); }, 120000);
  try {
    const surfaces = splitSpeechResponse(JSON.stringify({ display_text: voiceSurfaces.display, spoken_text: voiceSurfaces.spoken }));
    assert(surfaces.spoken && surfaces.spoken.length <= 600 && surfaces.display.length > surfaces.spoken.length);
    const tts = new ElevenLabsTts(key), stt = new ElevenLabsStt(key);
    const started = Date.now(), chunks = [];
    report.tts = { model: 'eleven_v3_conversational', characters: surfaces.spoken.length };
    for await (const chunk of tts.synthesize({ text: (async function* () { yield surfaces.spoken; })(), voiceId, language: 'th', outputFormat: PCM16, signal: AbortSignal.timeout(40000) })) {
      if (!chunks.length) report.tts.firstAudioMs = Date.now() - started;
      chunks.push(chunk.bytes); assert(chunks.reduce((n, c) => n + c.length, 0) <= 960000, 'Audio exceeds 30-second bound');
    }
    const pcm = Buffer.concat(chunks); assert(pcm.length > 3200 && pcm.some(b => b));
    Object.assign(report.tts, { durationMs: Date.now() - started, audioSeconds: pcm.length / 32000, chunks: chunks.length });
    const path = join(root, 'summary.wav'); fs.writeFileSync(path, wav(pcm), { mode: 0o600 });
    console.log(JSON.stringify({ stage: 'tts', ...report.tts }));
    const noteStart = Date.now();
    const transcript = await transcribeVoiceNote(path, { provider: 'elevenlabs', model: 'scribe_v2', language: 'th' });
    assert(/สำเร็จ/.test(transcript) && /บวก/.test(transcript), 'Thai file transcript lost key summary facts');
    report.note = { model: 'scribe_v2', transcript, durationMs: Date.now() - noteStart };
    console.log(JSON.stringify({ stage: 'file-stt', ...report.note }));
    const controls = [], spokenInputs = [], output = []; let listening, played = 0, submittedText;
    const tracedTts = { id: tts.id, capabilities: tts.capabilities, synthesize: options => tts.synthesize({ ...options, text: (async function* () {
      for await (const text of options.text) { spokenInputs.push(text); assert.equal(text, surfaces.spoken); yield text; }
    })() }) };
    session = new VoiceSession(stt, tracedTts, voiceId, {
      control: c => { controls.push(c); if (c.type === 'voice.state' && c.state === 'listening') listening = c; },
      audio: bytes => { const frame = decodeVoiceFrame(bytes); output.push(frame.audio); played += frame.audio.length / 2; session.progress(frame.epoch, played); },
      bufferedBytes: () => 0,
    }, async text => {
      submittedText = text;
      assert(/สำเร็จ/.test(text) && /บวก/.test(text), 'Realtime transcript lost key summary facts');
      return { inputId: 'live-summary-proof', response: Promise.resolve(surfaces.display), responseId: () => 'summary-proof',
        stream: (async function* () { yield { responseId: 'summary-proof', text: surfaces.spoken }; })() };
    }, () => {}, { language: 'th', silenceCommitMs: 650, finalizationTimeoutMs: 15000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500 });
    await session.start(); const turn = listening; let sequence = 0;
    const mic = Buffer.concat([pcm, Buffer.alloc(16000)]);
    for (let offset = 0; offset < mic.length; offset += 3200) {
      await session.audio({ generation: turn.generation, epoch: turn.epoch, sequence: ++sequence, segmentId: turn.utterance_id, audio: mic.subarray(offset, offset + 3200) });
      await sleep(100);
    }
    const commitStart = Date.now(); await session.commit(sequence);
    const deadline = Date.now() + 40000;
    while (!controls.some(c => c.type === 'playback.end' || c.type === 'voice.error') && Date.now() < deadline) await sleep(20);
    assert.deepEqual(controls.filter(c => c.type === 'voice.error'), []);
    assert(controls.some(c => c.type === 'playback.end'), 'Missing final audio');
    assert(controls.some(c => c.type === 'response.text' && c.text === surfaces.display && c.final));
    assert.deepEqual(spokenInputs, [surfaces.spoken]); assert(output.length > 0);
    report.voiceSession = { transcript: submittedText, partials: controls.filter(c => c.type === 'stt.partial').length,
      displayCharacters: surfaces.display.length, ttsCharacters: spokenInputs.join('').length, audioSeconds: played / 16000,
      commitToPlaybackEndMs: Date.now() - commitStart, nextTurnListening: listening.utterance_id !== turn.utterance_id, fullReportExcludedFromTts: true };
    fs.writeFileSync(join(root, 'playback.wav'), wav(Buffer.concat(output)), { mode: 0o600 });
    assert(report.voiceSession.nextTurnListening); report.pass = true;
  } catch (error) { report.error = { code: error.code, message: String(error.message).replaceAll(key, '[redacted]') }; }
  finally { await session?.close(); clearTimeout(watchdog); fs.writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2)); }
  process.exitCode = report.pass ? 0 : 1;
})().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
