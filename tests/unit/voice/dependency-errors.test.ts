import { describeVoiceError } from '../../../src/voice/errors';
import { convertLineAudio } from '../../../src/voice/line-audio';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs/promises', () => ({ stat: jest.fn() }));

describe('local audio dependency diagnostics', () => {
  beforeEach(() => jest.resetAllMocks());
  it.each(['TTS_DECODER_UNAVAILABLE', 'VOICE_DEPENDENCY_FFMPEG_UNAVAILABLE', 'VOICE_DEPENDENCY_FFPROBE_UNAVAILABLE'])('does not blame the provider for %s', code => {
    expect(describeVoiceError(new Error(code))).toMatchObject({ category: 'local_dependency', retryable: false,
      message: expect.stringContaining('claude-gateway doctor fix') });
  });
  it('keeps genuine decoding failures classified separately', () => {
    expect(describeVoiceError(new Error('TTS_DECODE_FAILED')).category).toBe('invalid_response');
  });
  it.each(['ffmpeg', 'ffprobe'])('identifies missing %s during LINE conversion', async missing => {
    (stat as jest.Mock).mockResolvedValue({ size: 100 });
    (execFile as unknown as jest.Mock).mockImplementation((file, _args, _options, callback) => {
      callback(file === missing ? Object.assign(new Error('missing'), { code: 'ENOENT' }) : null, '', '');
    });
    await expect(convertLineAudio('/input', '/output')).rejects.toThrow(`VOICE_DEPENDENCY_${missing.toUpperCase()}_UNAVAILABLE`);
  });
});
