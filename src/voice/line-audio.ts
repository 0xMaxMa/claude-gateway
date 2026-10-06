import { execFile } from 'child_process';
import { promisify } from 'util';
import { VoiceError } from './types';
import { stat } from 'fs/promises';

/** LINE's native player receives an AAC-LC M4A with metadata before media data.
 * No shell, metadata, artwork, video tracks or provider container assumptions. */
export const LINE_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const LINE_AUDIO_MAX_SECONDS = 600;

/** A LINE conversion failure with a specific code and a message carrying the measured numbers (never content). */
export class LineAudioError extends VoiceError {
  constructor(code: string, readonly detail: string) { super(code); }
}

/** `bitrate` defaults to 96k for short replies; staged long-form audio passes 64k so 10 minutes of speech fits LINE's 5 MB cap. */
export async function convertLineAudio(input: string, output: string, bitrate = '96k'): Promise<number> {
  const execute = promisify(execFile);
  const run = async (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
    try { return await execute(file, args, options); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') {
        throw new VoiceError(`VOICE_DEPENDENCY_${file === 'ffprobe' ? 'FFPROBE' : 'FFMPEG'}_UNAVAILABLE`);
      }
      throw error;
    }
  };
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', bitrate, '-ar', '44100', '-ac', '1',
    '-movflags', '+faststart', '-f', 'ipod', output], { timeout: 30000, maxBuffer: 65536 });
  const size = (await stat(output)).size;
  if (!size || size > LINE_AUDIO_MAX_BYTES) {
    throw new LineAudioError('LINE_AUDIO_SIZE_INVALID', `converted audio is ${size} bytes; LINE accepts at most ${LINE_AUDIO_MAX_BYTES} bytes`);
  }
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,profile,channels,sample_rate', '-of', 'json', output],
    { timeout: 5000, maxBuffer: 16384 });
  const info = JSON.parse(stdout), stream = info.streams?.[0], duration = Number(info.format?.duration);
  if (info.streams?.length !== 1 || stream.codec_name !== 'aac' || stream.profile !== 'LC' ||
    stream.channels !== 1 || Number(stream.sample_rate) !== 44100 || !Number.isFinite(duration) || duration <= 0 || duration > LINE_AUDIO_MAX_SECONDS) {
    throw new LineAudioError('LINE_AUDIO_FORMAT_INVALID', `converted audio is ${Number.isFinite(duration) ? Math.ceil(duration) : 'of unknown'} seconds or not AAC-LC mono 44.1 kHz; LINE accepts at most ${LINE_AUDIO_MAX_SECONDS} seconds`);
  }
  return Math.ceil(duration * 1000);
}
