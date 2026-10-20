import { JEV_IMAGE_MAX_SIDE, JEV_IMAGE_MIN_SIDE, type JevBox } from '../jev/types';

/**
 * Screenshots prepared for Jev image questions. Every rectangle and point is in the caller's coordinate space
 * (the space raw input is bound to), whatever the capture's pixel size (a Retina capture is twice as large).
 * sharp is loaded lazily, as in shared/image-optimize: a native module must not load for every importer.
 */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
/** A Set-of-Mark label: `id` drawn at the control's top-left corner with an outline around it. */
export interface Mark { id: string; rect: Rect }
/** One image as Jev receives it. `origin` and `unitsPerPixel` (per axis) map its pixels back to the coordinate space. */
export interface JevImage { data: string; format: 'jpg'; width: number; height: number; origin: Point; unitsPerPixel: Point }

type Sharp = typeof import('sharp').default;
let sharpModule: Sharp | undefined;
async function loadSharp(): Promise<Sharp> {
  if (sharpModule) return sharpModule;
  // A bare function under plain require, or under .default once esModuleInterop wraps it.
  const mod = await import('sharp') as unknown as { default?: unknown };
  const factory = typeof mod === 'function' ? mod : mod.default;
  if (typeof factory !== 'function') throw Error('IMAGE_PREPARATION_UNAVAILABLE');
  return sharpModule = factory as Sharp;
}

const MARK_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

type Raw = { width: number; height: number; channels: 1 | 2 | 3 | 4 };
export class ScreenImage {
  private constructor(private readonly sharp: Sharp, private readonly pixels: Buffer, private readonly raw: Raw, private readonly space: { width: number; height: number }) {}

  /** Decode a PNG or JPEG capture (coordinates in `space`, by default its own pixels) and paint every `mask` rectangle
   * solid before anything else can read it: sensitive fields never reach a request, a crop or a mark. Kept as raw
   * pixels, so each render decodes nothing. */
  static async open(capture: Buffer, space?: { width: number; height: number }, mask: Rect[] = []): Promise<ScreenImage> {
    const sharp = await loadSharp();
    const { width, height } = await sharp(capture).metadata();
    space ??= width && height ? { width, height } : undefined;
    if (!width || !height || !space || space.width <= 0 || space.height <= 0) throw Error('SCREENSHOT_INVALID');
    const sx = width / space.width, sy = height / space.height;
    const rects = mask.map(r => `<rect x="${Math.floor(r.x * sx)}" y="${Math.floor(r.y * sy)}" width="${Math.ceil(r.width * sx) + 1}" height="${Math.ceil(r.height * sy) + 1}" fill="#000"/>`).join('');
    const { data, info } = await sharp(capture).removeAlpha().composite(rects ? [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`), top: 0, left: 0 }] : []).raw().toBuffer({ resolveWithObject: true });
    return new ScreenImage(sharp, data, { width: info.width, height: info.height, channels: info.channels }, space);
  }

  /** The whole screen or a `crop` of it, with optional marks and a dot, scaled into the Jev side limits
   * (down to fit 1568 px; a side under 280 px is padded on the right or bottom, so origin stays top-left).
   * The crop is cut and scaled first; marks and the dot are drawn on the result, at a legible fixed size. */
  async render(options: { crop?: Rect; marks?: Mark[]; dot?: Point } = {}): Promise<JevImage> {
    const sx = this.raw.width / this.space.width, sy = this.raw.height / this.space.height;
    const area = options.crop ?? { x: 0, y: 0, width: this.space.width, height: this.space.height };
    const left = Math.max(0, Math.round(area.x * sx)), top = Math.max(0, Math.round(area.y * sy));
    const width = Math.max(1, Math.min(this.raw.width - left, Math.round(area.width * sx))), height = Math.max(1, Math.min(this.raw.height - top, Math.round(area.height * sy)));
    const scale = Math.min(1, JEV_IMAGE_MAX_SIDE / width, JEV_IMAGE_MAX_SIDE / height);
    const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
    // Space units to output pixels.
    const ox = (x: number) => Math.round((x * sx - left) * scale), oy = (y: number) => Math.round((y * sy - top) * scale);
    const font = 13, stroke = 2;
    const svg = [
      ...(options.marks ?? []).map((m, i) => {
        const color = MARK_COLORS[i % MARK_COLORS.length], x = ox(m.rect.x), y = oy(m.rect.y);
        const labelWidth = Math.round(font * (0.65 * m.id.length + 0.6)), labelHeight = Math.round(font * 1.3), ly = Math.max(0, y - labelHeight);
        return `<rect x="${x}" y="${y}" width="${Math.round(m.rect.width * sx * scale)}" height="${Math.round(m.rect.height * sy * scale)}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`
          + `<rect x="${x}" y="${ly}" width="${labelWidth}" height="${labelHeight}" fill="${color}"/>`
          + `<text x="${x + Math.round(font * 0.3)}" y="${ly + Math.round(font * 1.02)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${font}" fill="#fff">${escape(m.id)}</text>`;
      }),
      ...(options.dot ? [`<circle cx="${ox(options.dot.x)}" cy="${oy(options.dot.y)}" r="6" fill="#f00" stroke="#fff" stroke-width="${stroke}"/>`] : []),
    ].join('');
    const scaled = await this.sharp(this.pixels, { raw: this.raw }).extract({ left, top, width, height }).resize(outWidth, outHeight, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const padRight = Math.max(0, JEV_IMAGE_MIN_SIDE - outWidth), padBottom = Math.max(0, JEV_IMAGE_MIN_SIDE - outHeight);
    const data = await this.sharp(scaled.data, { raw: { width: scaled.info.width, height: scaled.info.height, channels: scaled.info.channels } })
      .composite(svg ? [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}">${svg}</svg>`), top: 0, left: 0 }] : [])
      .extend({ right: padRight, bottom: padBottom, background: '#808080' }).flatten({ background: '#808080' }).jpeg({ quality: 85 }).toBuffer();
    return { data: data.toString('base64'), format: 'jpg', width: outWidth + padRight, height: outHeight + padBottom, origin: { x: left / sx, y: top / sy }, unitsPerPixel: { x: 1 / (sx * scale), y: 1 / (sy * scale) } };
  }

  /** A coarse grey thumbnail for change detection: a blinking caret or a ticking clock moves almost none of it. */
  async thumbnail(): Promise<Buffer> {
    return this.sharp(this.pixels, { raw: this.raw }).resize(THUMB.width, THUMB.height, { fit: 'fill' }).greyscale().raw().toBuffer();
  }
}
const THUMB = { width: 48, height: 30 };
/** Two thumbnails differ when more than 1% of their cells changed noticeably. */
export function screensDiffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return true;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) changed++;
  return changed > a.length / 100;
}

/** The center of a normalized Jev box, in the coordinate space. */
export function boxCenter(image: JevImage, box: JevBox): Point {
  return { x: image.origin.x + (box.left + box.right) / 2 * image.width * image.unitsPerPixel.x, y: image.origin.y + (box.top + box.bottom) / 2 * image.height * image.unitsPerPixel.y };
}
