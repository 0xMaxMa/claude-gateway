/**
 * End-to-end tests for src/shared/image-optimize.ts against the REAL `sharp`
 * encoder — the companion to image-optimize.test.ts, which mocks sharp to pin
 * the sweep order exactly.
 *
 * What only a real encoder can prove: that the dependency actually loads and
 * produces decodable JPEG, that a genuinely oversized picture really does end
 * up under an arbitrary cap, and that alpha is flattened rather than composited
 * onto black. Byte counts are never asserted exactly here (they move with
 * libjpeg's version) — only the properties that must hold.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { optimizeImage, optimizeImageFile } from '../../src/shared/image-optimize';

/**
 * A large, deliberately INCOMPRESSIBLE PNG: random pixels defeat PNG's
 * predictors, so the encoded file stays close to raw size. A gradient or a
 * solid colour would compress to a few KB and never exercise the sweep.
 */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3);
  // A cheap LCG rather than crypto randomness — reproducible and much faster
  // for a multi-megabyte buffer.
  let seed = 0x2545f491;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = seed & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

/** JPEG SOI marker — the two bytes every JPEG starts with. */
function isJpeg(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

describe('optimizeImage with the real sharp encoder', () => {
  let big: Buffer;

  beforeAll(async () => {
    big = await noisyPng(1200, 1200);
    // Sanity-check the fixture itself: if this ever compresses small, the
    // shrink assertions below would pass vacuously.
    expect(big.length).toBeGreaterThan(3_000_000);
  }, 30000);

  it('shrinks an oversized image under an aggressive cap and returns valid JPEG', async () => {
    const cap = 150_000;
    const out = await optimizeImage(big, cap);

    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out.length).toBeLessThan(big.length);
    expect(isJpeg(out)).toBe(true);
    // Still a real, decodable image — not truncated bytes.
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.format).toBe('jpeg');
  }, 30000);

  it('leaves an already-small image completely untouched (same instance, same bytes)', async () => {
    const small = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

    const out = await optimizeImage(small, 5_000_000);
    expect(out).toBe(small);
    expect(out.equals(small)).toBe(true);
  });

  it('preserves the aspect ratio when it has to scale the image down', async () => {
    const wide = await noisyPng(1600, 400);
    const out = await optimizeImage(wide, 40_000);
    const meta = await sharp(out).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(4, 1);
  }, 30000);

  it('flattens transparency onto white rather than JPEG\'s default black', async () => {
    // Large and stored UNCOMPRESSED so every JPEG attempt is genuinely smaller
    // than the source — otherwise the module would (correctly) hand back the
    // original PNG and there would be no JPEG to inspect.
    const transparent = await sharp({
      create: { width: 1200, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    // A cap of 1 byte forces the full sweep to run, so we always get JPEG back.
    const out = await optimizeImage(transparent, 1);
    expect(isJpeg(out)).toBe(true);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    // Near-white, allowing for JPEG's lossy round-trip.
    expect(data[0]).toBeGreaterThan(240);
  });

  it('returns the input untouched when the bytes are not a decodable image', async () => {
    const garbage = Buffer.alloc(20_000, 0x7f);
    const out = await optimizeImage(garbage, 100);
    expect(out).toBe(garbage);
  });

  describe('optimizeImageFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-optimize-sharp-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes a smaller .jpg beside the untouched original', async () => {
      const src = path.join(tmpDir, 'screenshot.png');
      fs.writeFileSync(src, big);

      const out = await optimizeImageFile(src, 150_000);

      expect(out).not.toBe(src);
      expect(path.extname(out)).toBe('.jpg');
      expect(fs.statSync(out).size).toBeLessThanOrEqual(150_000);
      expect(fs.statSync(src).size).toBe(big.length);
      expect(isJpeg(fs.readFileSync(out))).toBe(true);
      fs.unlinkSync(out);
    }, 30000);
  });
});
