/**
 * Contract tests for src/shared/image-optimize.ts with `sharp` mocked at the
 * module boundary.
 *
 * The sweep is the whole point of this module — which quality steps are tried,
 * in what order, when dimensions start getting sacrificed, and what comes back
 * when nothing fits — and none of that is observable through real JPEG output
 * (whose byte counts depend on libjpeg's version and the source pixels). The
 * fake encoder below makes output size a pure function of quality and scale, so
 * every branch is assertable exactly. A companion suite
 * (image-optimize-sharp.test.ts) covers the real encoder end to end.
 */

/** Every toBuffer() the module performed, in order. */
const encodeCalls: Array<{ quality: number; scale: number }> = [];
/** Fake encoder — swapped per test to steer which sweep step fits. */
let encodedSize: (quality: number, scale: number) => number = () => 0;
/** Width reported by metadata(); undefined models "sharp could not tell us". */
let metadataWidth: number | undefined = 1000;
/** When set, metadata() rejects with it (models sharp failing / bad bytes). */
let metadataError: Error | null = null;

const SOURCE_WIDTH = 1000;

jest.mock('sharp', () => {
  const factory = () => {
    let scale = 1;
    let quality = 0;
    const api = {
      metadata: async () => {
        if (metadataError) throw metadataError;
        return { width: metadataWidth, height: 800 };
      },
      rotate: () => api,
      resize: (o: { width: number }) => {
        scale = o.width / SOURCE_WIDTH;
        return api;
      },
      flatten: () => api,
      jpeg: (o: { quality: number }) => {
        quality = o.quality;
        return api;
      },
      toBuffer: async () => {
        encodeCalls.push({ quality, scale });
        return Buffer.alloc(encodedSize(quality, scale));
      },
    };
    return api;
  };
  return { __esModule: true, default: factory };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { optimizeImage, optimizeImageFile } from '../../src/shared/image-optimize';

/** A stand-in source image. Contents are irrelevant — the fake encoder ignores them. */
function source(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0xab);
}

beforeEach(() => {
  encodeCalls.length = 0;
  metadataWidth = SOURCE_WIDTH;
  metadataError = null;
  encodedSize = () => 0;
});

describe('optimizeImage — inputs that must come back untouched', () => {
  it('returns the ORIGINAL buffer (same instance) when it already fits, without loading sharp', async () => {
    const buf = source(500);
    const out = await optimizeImage(buf, 1000);
    expect(out).toBe(buf);
    expect(encodeCalls).toEqual([]);
  });

  it('returns the original when it is exactly at the cap (boundary is inclusive)', async () => {
    const buf = source(1000);
    expect(await optimizeImage(buf, 1000)).toBe(buf);
    expect(encodeCalls).toEqual([]);
  });

  it('returns the original for an empty buffer', async () => {
    const buf = Buffer.alloc(0);
    expect(await optimizeImage(buf, 10)).toBe(buf);
    expect(encodeCalls).toEqual([]);
  });

  it('returns the original for a non-positive or non-finite cap rather than sweeping forever', async () => {
    const buf = source(5000);
    expect(await optimizeImage(buf, 0)).toBe(buf);
    expect(await optimizeImage(buf, -1)).toBe(buf);
    expect(await optimizeImage(buf, Number.NaN)).toBe(buf);
    expect(encodeCalls).toEqual([]);
  });
});

describe('optimizeImage — quality sweep', () => {
  it('stops at the FIRST quality that fits and never tries a lower one', async () => {
    // 80 → 8000 (over), 60 → 6000 (fits). 40 must never run.
    encodedSize = (q) => q * 100;
    const out = await optimizeImage(source(50_000), 6500);

    expect(out.length).toBe(6000);
    expect(encodeCalls).toEqual([
      { quality: 80, scale: 1 },
      { quality: 60, scale: 1 },
    ]);
  });

  it('tries quality 80 first — the highest-fidelity step that could work', async () => {
    encodedSize = () => 10;
    await optimizeImage(source(50_000), 100);
    expect(encodeCalls[0]).toEqual({ quality: 80, scale: 1 });
  });

  it('keeps the ORIGINAL dimensions throughout the quality sweep (scale stays 1)', async () => {
    encodedSize = (q) => q * 1000; // nothing fits at full size
    await optimizeImage(source(500_000), 1000);
    const qualityPhase = encodeCalls.slice(0, 3);
    expect(qualityPhase.every((c) => c.scale === 1)).toBe(true);
    expect(qualityPhase.map((c) => c.quality)).toEqual([80, 60, 40]);
  });
});

describe('optimizeImage — dimension sweep', () => {
  it('only starts sacrificing pixels after all three quality steps failed', async () => {
    // 100k bytes scaled by quality and by area; cap fits at the first 0.75 step.
    encodedSize = (q, s) => Math.round(100_000 * (q / 100) * s * s);
    const out = await optimizeImage(source(500_000), 25_000);

    expect(encodeCalls.map((c) => c.quality)).toEqual([80, 60, 40, 40]);
    expect(encodeCalls[3]!.scale).toBeCloseTo(0.75);
    expect(out.length).toBe(22_500);
  });

  it('walks the scale steps in descending order, all at the lowest quality', async () => {
    encodedSize = (q, s) => Math.round(100_000 * (q / 100) * s * s);
    await optimizeImage(source(500_000), 1);

    const scalePhase = encodeCalls.slice(3);
    expect(scalePhase.map((c) => c.scale.toFixed(2))).toEqual(['0.75', '0.50', '0.35', '0.25']);
    expect(scalePhase.every((c) => c.quality === 40)).toBe(true);
  });

  it('skips the dimension sweep entirely when sharp reports no width', async () => {
    metadataWidth = undefined;
    encodedSize = () => 999_999;
    await optimizeImage(source(500_000), 1);
    expect(encodeCalls).toHaveLength(3);
    expect(encodeCalls.every((c) => c.scale === 1)).toBe(true);
  });
});

describe('optimizeImage — best-effort fallbacks (never throws)', () => {
  it('returns the SMALLEST attempt when even the most aggressive setting is over cap', async () => {
    encodedSize = (q, s) => Math.round(100_000 * (q / 100) * s * s);
    const out = await optimizeImage(source(500_000), 1);

    // Smallest possible attempt: quality 40 at scale 0.25 → 100000*0.4*0.0625.
    expect(out.length).toBe(2500);
    expect(encodeCalls).toHaveLength(7);
  });

  it('returns the original when every attempt would be LARGER than the source', async () => {
    const buf = source(5000);
    encodedSize = () => 900_000;
    const out = await optimizeImage(buf, 1000);
    expect(out).toBe(buf);
  });

  it('returns the original — and does not throw — when sharp itself fails', async () => {
    metadataError = new Error('Input buffer contains unsupported image format');
    const buf = source(5000);
    await expect(optimizeImage(buf, 1000)).resolves.toBe(buf);
  });

  it('still returns the best attempt made before a mid-sweep failure', async () => {
    // First encode succeeds and is smaller than the source; the second throws.
    let n = 0;
    encodedSize = () => {
      n++;
      if (n === 1) return 4000;
      throw new Error('encode blew up');
    };
    const out = await optimizeImage(source(5000), 1000);
    expect(out.length).toBe(4000);
  });
});

describe('optimizeImageFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-optimize-file-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the SOURCE path unchanged when the file already fits (no temp file made)', async () => {
    const src = path.join(tmpDir, 'small.png');
    fs.writeFileSync(src, source(100));
    expect(await optimizeImageFile(src, 10_000)).toBe(src);
    expect(encodeCalls).toEqual([]);
  });

  it('writes the shrunk bytes to a NEW .jpg temp file and returns that path', async () => {
    const src = path.join(tmpDir, 'huge.png');
    fs.writeFileSync(src, source(50_000));
    encodedSize = () => 900;

    const out = await optimizeImageFile(src, 1000);

    expect(out).not.toBe(src);
    expect(path.extname(out)).toBe('.jpg');
    expect(fs.statSync(out).size).toBe(900);
    // The source is left completely alone — callers may still need it.
    expect(fs.statSync(src).size).toBe(50_000);
    fs.unlinkSync(out);
  });

  it('returns the source path when optimization did not actually make it smaller', async () => {
    const src = path.join(tmpDir, 'incompressible.png');
    fs.writeFileSync(src, source(5000));
    encodedSize = () => 800_000;
    expect(await optimizeImageFile(src, 1000)).toBe(src);
  });

  it('returns the source path for an unreadable/missing file instead of throwing', async () => {
    const missing = path.join(tmpDir, 'nope.png');
    await expect(optimizeImageFile(missing, 1000)).resolves.toBe(missing);
  });
});
