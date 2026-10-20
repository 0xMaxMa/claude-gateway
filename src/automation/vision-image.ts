import { JEV_IMAGE_MAX_SIDE, JEV_IMAGE_MIN_SIDE } from '../jev/validation';
import type { JevBox } from '../jev/types';

/**
 * Screenshots prepared for Jev image questions. Every rectangle and point is in the caller's coordinate space
 * (the space raw input is bound to), whatever the capture's pixel size (a Retina capture is twice as large).
 * sharp is loaded lazily, as in shared/image-optimize: a native module must not load for every importer.
 */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
/** A Set-of-Mark label: `id` drawn at the control's top-left corner with an outline around it. */
export interface Mark { id: string; rect: Rect }
/** One image as Jev receives it. `origin` and `unitsPerPixel` map its pixels back to the coordinate space. */
export interface JevImage { data: string; format: 'jpg'; width: number; height: number; origin: Point; unitsPerPixel: number }

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

export class ScreenImage {
  private constructor(private readonly sharp: Sharp, private readonly pixels: Buffer, private readonly width: number, private readonly height: number, private readonly space: { width: number; height: number }) {}

  /** Decode a PNG or JPEG capture (coordinates in `space`, by default its own pixels) and paint every `mask` rectangle solid before anything else can read it:
   * sensitive fields never reach a request, a crop or a mark. */
  static async open(capture: Buffer, space?: { width: number; height: number }, mask: Rect[] = []): Promise<ScreenImage> {
    const sharp = await loadSharp();
    const { width, height } = await sharp(capture).metadata();
    space ??= width && height ? { width, height } : undefined;
    if (!width || !height || !space || space.width <= 0 || space.height <= 0) throw Error('SCREENSHOT_INVALID');
    const sx = width / space.width, sy = height / space.height;
    const rects = mask.map(r => `<rect x="${Math.floor(r.x * sx)}" y="${Math.floor(r.y * sy)}" width="${Math.ceil(r.width * sx) + 1}" height="${Math.ceil(r.height * sy) + 1}" fill="#000"/>`).join('');
    const pixels = await sharp(capture).composite(rects ? [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`), top: 0, left: 0 }] : []).png({ compressionLevel: 1 }).toBuffer();
    return new ScreenImage(sharp, pixels, width, height, space);
  }

  /** The whole screen or a `crop` of it, with optional marks and a dot, scaled into the Jev side limits
   * (down to fit 1568 px; a side under 280 px is padded on the right or bottom, so origin stays top-left). */
  async render(options: { crop?: Rect; marks?: Mark[]; dot?: Point } = {}): Promise<JevImage> {
    const sx = this.width / this.space.width, sy = this.height / this.space.height;
    const area = options.crop ?? { x: 0, y: 0, width: this.space.width, height: this.space.height };
    const left = Math.max(0, Math.round(area.x * sx)), top = Math.max(0, Math.round(area.y * sy));
    const width = Math.max(1, Math.min(this.width - left, Math.round(area.width * sx))), height = Math.max(1, Math.min(this.height - top, Math.round(area.height * sy)));
    const scale = Math.min(1, JEV_IMAGE_MAX_SIDE / width, JEV_IMAGE_MAX_SIDE / height);
    // Labels and the dot are drawn in capture pixels, sized to stay legible after scaling.
    const unit = Math.max(1, 1 / scale), font = Math.round(13 * unit), stroke = Math.max(1, Math.round(2 * unit));
    const svg = [
      ...(options.marks ?? []).map((m, i) => {
        const color = MARK_COLORS[i % MARK_COLORS.length], x = Math.round(m.rect.x * sx), y = Math.round(m.rect.y * sy);
        const labelWidth = Math.round(font * (0.65 * m.id.length + 0.6)), labelHeight = Math.round(font * 1.3), ly = Math.max(0, y - labelHeight);
        return `<rect x="${x}" y="${y}" width="${Math.round(m.rect.width * sx)}" height="${Math.round(m.rect.height * sy)}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`
          + `<rect x="${x}" y="${ly}" width="${labelWidth}" height="${labelHeight}" fill="${color}"/>`
          + `<text x="${x + Math.round(font * 0.3)}" y="${ly + Math.round(font * 1.02)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${font}" fill="#fff">${escape(m.id)}</text>`;
      }),
      ...(options.dot ? [`<circle cx="${Math.round(options.dot.x * sx)}" cy="${Math.round(options.dot.y * sy)}" r="${Math.round(6 * unit)}" fill="#f00" stroke="#fff" stroke-width="${stroke}"/>`] : []),
    ].join('');
    const drawn = svg ? await this.sharp(this.pixels).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">${svg}</svg>`), top: 0, left: 0 }]).png({ compressionLevel: 1 }).toBuffer() : this.pixels;
    const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
    const padRight = Math.max(0, JEV_IMAGE_MIN_SIDE - outWidth), padBottom = Math.max(0, JEV_IMAGE_MIN_SIDE - outHeight);
    const data = await this.sharp(drawn).extract({ left, top, width, height }).resize(outWidth, outHeight, { fit: 'fill' })
      .extend({ right: padRight, bottom: padBottom, background: '#808080' }).flatten({ background: '#808080' }).jpeg({ quality: 85 }).toBuffer();
    return { data: data.toString('base64'), format: 'jpg', width: outWidth + padRight, height: outHeight + padBottom, origin: { x: left / sx, y: top / sy }, unitsPerPixel: 1 / (sx * scale) };
  }
}

/** The center of a normalized Jev box, in the coordinate space. */
export function boxCenter(image: JevImage, box: JevBox): Point {
  return { x: image.origin.x + (box.left + box.right) / 2 * image.width * image.unitsPerPixel, y: image.origin.y + (box.top + box.bottom) / 2 * image.height * image.unitsPerPixel };
}
