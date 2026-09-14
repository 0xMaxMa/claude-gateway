import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';

/** LINE's native player receives an AAC-LC M4A with metadata before media data.
 * No shell, metadata, artwork, video tracks or provider container assumptions. */
export async function convertLineAudio(input: string, output: string): Promise<number> {
  const run = promisify(execFile);
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-ar', '44100', '-ac', '1',
    '-movflags', '+faststart', '-f', 'ipod', output], { timeout: 30000, maxBuffer: 65536 });
  const size = (await stat(output)).size;
  if (!size || size > 5 * 1024 * 1024) throw new Error('LINE_AUDIO_SIZE_INVALID');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,profile,channels,sample_rate', '-of', 'json', output],
    { timeout: 5000, maxBuffer: 16384 });
  const info = JSON.parse(stdout), stream = info.streams?.[0], duration = Number(info.format?.duration);
  if (info.streams?.length !== 1 || stream.codec_name !== 'aac' || stream.profile !== 'LC' ||
    stream.channels !== 1 || Number(stream.sample_rate) !== 44100 || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
    throw new Error('LINE_AUDIO_FORMAT_INVALID');
  }
  return Math.ceil(duration * 1000);
}
