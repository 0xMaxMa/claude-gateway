/**
 * Cross-channel inbound media helpers.
 *
 * Shared by the channel webhook routers (LINE, Slack) so each one does not
 * carry its own copy of the same magic-byte table.
 */

/**
 * Pick a file extension from an image's magic bytes; default jpg.
 *
 * Sniffing (rather than trusting a platform-supplied `mimetype`/filename) is
 * deliberate: the field is attacker-controlled on every channel, and LINE does
 * not send one at all.
 */
export function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  return 'jpg';
}
