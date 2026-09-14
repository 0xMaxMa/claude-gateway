import { constants } from 'fs';
import { open } from 'fs/promises';
import { MediaStore } from '../history/media-store';
import type { InputImage } from '../session/input-image';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TURN_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 20;
function imageMime(bytes: Buffer): InputImage['source']['media_type'] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
/** Load only scoped ingress media. Keep original refs in storage and worker context;
 * base64 lives only in the transient inference request. Do not silently omit images. */
export async function loadInputImages(agentsRoot: string, agentId: string, refs: string[] = []): Promise<{
  images: InputImage[]; refs: string[]; unavailable: Array<{ ref: string; reason: string }>;
}> {
  const result: Awaited<ReturnType<typeof loadInputImages>> = { images: [], refs: [], unavailable: [] };
  let total = 0;
  for (const ref of [...new Set(refs)]) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(MediaStore.resolvePath(agentsRoot, agentId, ref), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      const header = Buffer.alloc(12);
      await file.read(header, 0, header.length, 0);
      const mime = imageMime(header);
      if (!mime) {
        if (/\.(png|jpe?g|gif|webp|heic|heif|avif|svg|bmp|tiff?)$/i.test(ref)) result.unavailable.push({ ref, reason: 'Unsupported or invalid image; resend as PNG, JPEG, GIF or WebP.' });
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_TURN_BYTES || result.images.length >= MAX_IMAGES) {
        result.unavailable.push({ ref, reason: 'Image input limit: 5 MiB per image, 20 MiB and 20 images per turn. Resize or send fewer images.' });
        continue;
      }
      // Bounded positional read even if the source file grows concurrently.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('incomplete image');
        offset += bytesRead;
      }
      result.images.push({ type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } });
      result.refs.push(ref); total += bytes.length;
    } catch {
      result.unavailable.push({ ref, reason: 'Attachment unavailable. Do not claim to have inspected it; ask the user to resend if needed.' });
    } finally { await file?.close(); }
  }
  return result;
}
