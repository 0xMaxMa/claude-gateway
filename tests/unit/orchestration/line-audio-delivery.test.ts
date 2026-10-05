import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sendChannelFile } from '../../../src/orchestration/file-delivery';
import { ingestOrchestrationMedia } from '../../../src/orchestration/media';
import { convertLineAudio, LineAudioError } from '../../../src/voice/line-audio';
import * as lineAudio from '../../../src/voice/line-audio';
import { VoiceError } from '../../../src/voice/types';
import { AgentConfig } from '../../../src/types';

let available = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { available = false; }
const media = available ? test : test.skip;

function noise(path: string, seconds: number) {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=24000`, '-c:a', 'libmp3lame', '-b:a', '48k', path]);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'line-delivery-')), workspace = join(root, 'a', 'workspace'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, 'a', '.public-base'), 'https://fixture.invalid/gateway');
  const before = process.env.SHARE_DB_PATH; process.env.SHARE_DB_PATH = join(root, 'shares.db');
  const agent = { id: 'a', workspace, line: { channelAccessToken: 'fixture' } } as AgentConfig;
  const binding = { channel: 'line', chat_id: 'Ufixture', conversation_id: 's', thread_key: '' };
  const stage = (seconds: number) => {
    const src = join(root, `in-${seconds}.mp3`); noise(src, seconds);
    return { path: ingestOrchestrationMedia(root, 'a', 'narrate', src), name: 'part.mp3', kind: 'audio' as const, caption: '' };
  };
  const send = jest.fn(async () => new Response(JSON.stringify({ sentMessages: [{ id: 'receipt' }] })));
  return { root, agent, binding, stage, send,
    close: () => { if (before === undefined) delete process.env.SHARE_DB_PATH; else process.env.SHARE_DB_PATH = before; rmSync(root, { recursive: true, force: true }); } };
}

afterEach(() => jest.restoreAllMocks());

describe('LINE audio conversion limits', () => {
  media('64k fits 600 seconds under LINE\'s 5 MB cap while the 96k default does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'line-600-'));
    try {
      const input = join(dir, 'in.mp3'); noise(input, 600);
      const duration = await convertLineAudio(input, join(dir, 'out64.m4a'), '64k');
      expect(duration).toBe(600000);
      expect(statSync(join(dir, 'out64.m4a')).size).toBeLessThan(5 * 1024 * 1024);
      const error = await convertLineAudio(input, join(dir, 'out96.m4a')).catch(e => e);
      expect(error).toBeInstanceOf(LineAudioError);
      expect(error).toMatchObject({ code: 'LINE_AUDIO_SIZE_INVALID', detail: expect.stringMatching(/is \d+ bytes; LINE accepts at most 5242880 bytes/) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90000);
});

describe('LINE staged audio delivery', () => {
  media('a 10-minute staged narration file is converted and delivered', async () => {
    const f = setup();
    try {
      const result = await sendChannelFile(f.agent, f.binding, f.stage(600), 'id-long', f.send as unknown as typeof fetch);
      expect(result.state).toBe('delivered');
      expect(JSON.parse(String((f.send.mock.calls[0] as unknown[])[1] ? ((f.send.mock.calls[0] as unknown[])[1] as RequestInit).body : '')).messages[0].duration).toBe(600000);
    } finally { f.close(); }
  }, 90000);

  test('missing ffmpeg is reported as LINE_AUDIO_FFMPEG_UNAVAILABLE and logged without content', async () => {
    const f = setup(), warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = { path: ingestOrchestrationMedia(f.root, 'a', 'narrate', (() => { const p = join(f.root, 'x.mp3'); writeFileSync(p, Buffer.from('ID3secret-audio-bytes')); return p; })()), name: 'part.mp3', kind: 'audio' as const, caption: '' };
    jest.spyOn(lineAudio, 'convertLineAudio').mockRejectedValue(new VoiceError('VOICE_DEPENDENCY_FFMPEG_UNAVAILABLE'));
    try {
      const result = await sendChannelFile(f.agent, f.binding, file, 'id-missing', f.send as unknown as typeof fetch);
      expect(result).toMatchObject({ state: 'failed', code: 'LINE_AUDIO_FFMPEG_UNAVAILABLE', message: expect.stringContaining('ffmpeg') });
      const logged = String(warn.mock.calls[0][0]);
      expect(logged).toContain('LINE_AUDIO_FFMPEG_UNAVAILABLE'); expect(logged).not.toContain('secret-audio-bytes');
      expect(f.send).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  media('input ffmpeg cannot decode is reported as LINE_AUDIO_CONVERSION_FAILED', async () => {
    const f = setup(); jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const bad = join(f.root, 'bad.mp3'); writeFileSync(bad, Buffer.from('not audio at all'));
      const file = { path: ingestOrchestrationMedia(f.root, 'a', 'narrate', bad), name: 'bad.mp3', kind: 'audio' as const, caption: '' };
      const result = await sendChannelFile(f.agent, f.binding, file, 'id-bad', f.send as unknown as typeof fetch);
      expect(result).toMatchObject({ state: 'failed', code: 'LINE_AUDIO_CONVERSION_FAILED' });
    } finally { f.close(); }
  });

  test('a file that still exceeds the cap is reported as LINE_AUDIO_TOO_LARGE with the limit and measured size', async () => {
    const f = setup(), warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = join(f.root, 'x.mp3'); writeFileSync(p, Buffer.from('ID3x'));
    const file = { path: ingestOrchestrationMedia(f.root, 'a', 'narrate', p), name: 'part.mp3', kind: 'audio' as const, caption: '' };
    jest.spyOn(lineAudio, 'convertLineAudio').mockRejectedValue(new LineAudioError('LINE_AUDIO_SIZE_INVALID', 'converted audio is 7346339 bytes; LINE accepts at most 5242880 bytes'));
    try {
      const result = await sendChannelFile(f.agent, f.binding, file, 'id-big', f.send as unknown as typeof fetch);
      expect(result).toMatchObject({ state: 'failed', code: 'LINE_AUDIO_TOO_LARGE', message: expect.stringMatching(/7346339 bytes.*5242880 bytes/) });
      expect(String(warn.mock.calls[0][0])).toContain('LINE_AUDIO_TOO_LARGE');
    } finally { f.close(); }
  });

  media('converted m4a files older than the retention window are swept on the next conversion; fresh ones stay', async () => {
    const f = setup();
    try {
      const dir = join(f.root, 'a', 'media', 'line-audio'); mkdirSync(dir, { recursive: true });
      const stale = join(dir, 'orchestration-stale.m4a'), fresh = join(dir, 'orchestration-fresh.m4a');
      writeFileSync(stale, 'x'); writeFileSync(fresh, 'y');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000); utimesSync(stale, old, old);
      const result = await sendChannelFile(f.agent, f.binding, f.stage(1), 'id-sweep', f.send as unknown as typeof fetch);
      expect(result.state).toBe('delivered');
      expect(existsSync(stale)).toBe(false); expect(existsSync(fresh)).toBe(true);
      expect(readdirSync(dir).filter(n => n.endsWith('.m4a')).length).toBe(2);
    } finally { f.close(); }
  }, 30000);
});
