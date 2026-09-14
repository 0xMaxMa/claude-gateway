import { VoiceError } from './types';

const HEADER_BYTES = 44;
function uuidBytes(value: string): Buffer {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new VoiceError('INVALID_FRAME_ID');
  return Buffer.from(value.replace(/-/g, ''), 'hex');
}
function uuid(buffer: Buffer): string { const h = buffer.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
export interface VoiceFrame { generation: string; epoch: number; sequence: number; segmentId: string; audio: Uint8Array; }
export function encodeVoiceFrame(frame: VoiceFrame): Buffer {
  if (!Number.isInteger(frame.epoch) || frame.epoch < 0 || frame.epoch > 0xffffffff || !Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffffffff) throw new VoiceError('INVALID_FRAME_SEQUENCE');
  const result = Buffer.alloc(HEADER_BYTES + frame.audio.length);
  result.write('CGV1'); uuidBytes(frame.generation).copy(result, 4); result.writeUInt32BE(frame.epoch, 20); result.writeUInt32BE(frame.sequence, 24);
  uuidBytes(frame.segmentId).copy(result, 28); Buffer.from(frame.audio).copy(result, HEADER_BYTES);
  return result;
}
export function decodeVoiceFrame(bytes: Buffer): VoiceFrame {
  if (bytes.length < HEADER_BYTES || bytes.length > HEADER_BYTES + 32000 || bytes.toString('ascii', 0, 4) !== 'CGV1' || (bytes.length - HEADER_BYTES) % 2) throw new VoiceError('INVALID_AUDIO_FRAME');
  return { generation: uuid(bytes.subarray(4, 20)), epoch: bytes.readUInt32BE(20), sequence: bytes.readUInt32BE(24), segmentId: uuid(bytes.subarray(28, 44)), audio: bytes.subarray(HEADER_BYTES) };
}
