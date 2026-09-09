/**
 * Best-effort image downscaler for OUTBOUND channel attachments.
 *
 * Both WhatsApp channels used to hard-fail an oversized image: the Baileys
 * manager threw `image exceeds N byte cap` and the Cloud MCP tool let Meta
 * reject the upload. From the agent's point of view that is the worst possible
 * outcome — it generated a perfectly good chart/screenshot and the reply just
 * disappears. Shrinking the picture is almost always what the human wanted, so
 * the send paths now run an over-cap image through `optimizeImage` first.
 *
 * Deliberately NOT applied on a document/`asDocument` send: sending as a
 * document is how the agent asks for the EXACT bytes to arrive (WhatsApp
 * re-compresses anything sent as a photo — see WhatsAppManager.sendMessage's
 * forceDocument comment), so recompressing there would defeat the only reason
 * to pick that mode.
 *
 * `sharp` is loaded lazily via dynamic import for two reasons: it is a native
 * module, so a static top-level import would make EVERY test that transitively
 * reaches the send paths pay its load cost (and fail outright on a platform
 * without a prebuilt binary), and a lazy load keeps this module importable —
 * and therefore mockable — even when sharp itself is unavailable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Quality sweep, tried at the ORIGINAL dimensions first. Most over-cap images
 * from an agent are large PNG screenshots whose size is encoding, not pixels —
 * a JPEG re-encode alone usually gets them under any sane cap while keeping
 * every pixel of detail, so dimensions are only sacrificed once quality alone
 * has failed.
 */
const QUALITY_STEPS = [80, 60, 40] as const;

/**
 * Dimension sweep, applied only after the quality sweep failed, each at the
 * lowest quality above. Scales (not fixed widths) so the aspect ratio and the
 * relationship to the source resolution are both preserved.
 */
const SCALE_STEPS = [0.75, 0.5, 0.35, 0.25] as const;

/** The most aggressive quality, reused for every scaled attempt. */
const MIN_QUALITY = QUALITY_STEPS[QUALITY_STEPS.length - 1];

type SharpFactory = (input: Buffer) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  rotate(): ReturnType<SharpFactory>;
  resize(opts: { width: number; withoutEnlargement: boolean }): ReturnType<SharpFactory>;
  flatten(opts: { background: string }): ReturnType<SharpFactory>;
  jpeg(opts: { quality: number; mozjpeg: boolean }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
};

let cachedSharp: SharpFactory | null = null;

/**
 * Resolve sharp's callable export across the CJS/ESM interop shapes it can
 * arrive in (a bare function under plain `require`, or under `.default` once
 * TypeScript's esModuleInterop wraps it). Throws if neither is present — every
 * caller here treats a throw as "leave the image alone".
 */
async function loadSharp(): Promise<SharpFactory> {
  if (cachedSharp) return cachedSharp;
  const mod: unknown = await import('sharp');
  const factory =
    typeof mod === 'function'
      ? (mod as SharpFactory)
      : ((mod as { default?: SharpFactory } | null)?.default);
  if (typeof factory !== 'function') throw new Error('sharp: no callable export');
  cachedSharp = factory;
  return factory;
}

/**
 * Shrink `buffer` until it fits `maxBytes`, or as close as this can get.
 *
 * Contract — never throws, always returns something sendable:
 *  - already at/under the cap (or an empty/`maxBytes <= 0` input) → the
 *    ORIGINAL buffer, byte for byte, with sharp never loaded at all;
 *  - a sweep step lands under the cap → that step's output;
 *  - every step still exceeds the cap → the SMALLEST attempt seen (which may
 *    still be over — the caller decides what to do with a best effort that was
 *    not enough), or the original if no attempt managed to beat it;
 *  - sharp missing, or the bytes are not a decodable image → the original.
 *
 * Output is JPEG. That is a deliberate narrowing rather than format
 * preservation: JPEG is the only format here with a quality knob that reliably
 * trades detail for bytes, and both WhatsApp channels re-encode a photo
 * on their own anyway. Transparency is flattened onto white first, because
 * JPEG has no alpha channel and sharp's default would composite onto black.
 */
export async function optimizeImage(buffer: Buffer, maxBytes: number): Promise<Buffer> {
  if (!buffer || buffer.length === 0) return buffer;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return buffer;
  if (buffer.length <= maxBytes) return buffer;

  let best = buffer;
  try {
    const sharp = await loadSharp();
    // `rotate()` with no argument applies the EXIF orientation and drops the
    // tag — without it a re-encoded phone photo can come out sideways.
    const { width } = await sharp(buffer).metadata();

    for (const quality of QUALITY_STEPS) {
      const out = await sharp(buffer)
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length < best.length) best = out;
      if (out.length <= maxBytes) return out;
    }

    // Quality alone was not enough — start giving up pixels too. Skipped
    // entirely when the source has no readable width (sharp could not tell us
    // the dimensions), since there is nothing sane to scale from.
    if (width && width > 0) {
      for (const scale of SCALE_STEPS) {
        const target = Math.max(1, Math.round(width * scale));
        const out = await sharp(buffer)
          .rotate()
          .resize({ width: target, withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: MIN_QUALITY, mozjpeg: true })
          .toBuffer();
        if (out.length < best.length) best = out;
        if (out.length <= maxBytes) return out;
      }
    }
  } catch {
    // sharp unavailable, or these bytes are not a decodable image. Best-effort
    // by contract: hand back whatever is smallest so the caller's existing
    // over-cap handling still runs, rather than failing the whole reply here.
  }
  return best;
}

/**
 * File-level wrapper for the two send paths: shrink `srcPath` under `maxBytes`
 * and return a path to the result.
 *
 * Returns `srcPath` UNCHANGED whenever nothing was gained — already under the
 * cap, unreadable, or `optimizeImage` handed back the original — so a caller
 * can compare identity to know whether a temp file was created. The temp file
 * lands in the OS temp dir with a `.jpg` extension matching what
 * `optimizeImage` actually produces, alongside the inbound media temp files
 * the channel routers already write there.
 */
export async function optimizeImageFile(srcPath: string, maxBytes: number): Promise<string> {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(srcPath);
  } catch {
    return srcPath;
  }
  const out = await optimizeImage(buf, maxBytes);
  if (out === buf || out.length >= buf.length) return srcPath;
  try {
    const dest = path.join(
      os.tmpdir(),
      `gw-optimized-${Date.now()}-${path.basename(srcPath, path.extname(srcPath)).slice(0, 64)}.jpg`,
    );
    fs.writeFileSync(dest, out);
    return dest;
  } catch {
    return srcPath;
  }
}
