/**
 * Canvas renderer for parsed OFD pages.
 *
 * Design notes
 * ------------
 * - Page IR is in millimetres. The renderer applies a single `ctx.scale(pxPerMm, pxPerMm)`
 *   up front, so every draw call can stay in millimetres and the output is resolution
 *   independent (thumbnail, screen, or print DPI).
 * - Every object's CTM is applied with `ctx.transform` — the reference JS OFD
 *   implementations skip this for images and paths.
 * - Bitmaps are supplied by an `ImageProvider`; resource IDs that are not decoded yet are
 *   returned in `RenderResult.pending` so the caller can repaint once they arrive.
 */

import { rgbToCss } from './types';
import { rotationOf } from '../lib/page-parser';
import type {
  GroupItem,
  ImageItem,
  Matrix,
  ParsedPage,
  PathItem,
  RenderItem,
  TextItem,
} from './types';

/** Average glyph advance as a fraction of the font size when the document gives none. */
const GLYPH_ADVANCE_RATIO = 1;
/** Browsers refuse very large 2D canvases; clamp to ~40 MPix. */
const MAX_CANVAS_AREA = 40_000_000;

export interface ImageProvider {
  /** Decoded bitmap, or null when it is not available yet (implementations schedule a decode). */
  get(resourceId: string): CanvasImageSource | null;
}

export interface RenderOptions {
  /** Output density in CSS pixels per millimetre (96dpi ≈ 3.7795). */
  pxPerMm: number;
  images: ImageProvider;
}

export interface RenderResult {
  width: number;
  height: number;
  /** Resource IDs referenced by the page but not decoded yet. */
  pending: string[];
  /** True when the output size was clamped to stay inside browser canvas limits. */
  clamped: boolean;
}

export function canvasSizeFor(widthMm: number, heightMm: number, pxPerMm: number) {
  const width = Math.max(1, Math.round(widthMm * pxPerMm));
  const height = Math.max(1, Math.round(heightMm * pxPerMm));
  const area = width * height;
  if (area <= MAX_CANVAS_AREA) return { width, height, clamped: false };

  const factor = Math.sqrt(MAX_CANVAS_AREA / area);
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
    clamped: true,
  };
}

function applyMatrix(ctx: CanvasRenderingContext2D, m: Matrix): void {
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

function fontShorthand(item: TextItem, fontSizeMm: number): string {
  const style = item.italic ? 'italic ' : '';
  const weight = item.fontWeight && item.fontWeight !== 400 ? `${item.fontWeight} ` : '';
  const family = item.fontFamily.includes(' ') ? `"${item.fontFamily}"` : item.fontFamily;
  return `${style}${weight}${fontSizeMm}px ${family}, sans-serif`;
}

function drawText(ctx: CanvasRenderingContext2D, source: TextItem): void {
  let item = source;
  const fontSize = Math.max(0.5, item.size);
  ctx.font = fontShorthand(item, fontSize);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (item.alpha !== 1) ctx.globalAlpha *= item.alpha;
  if (item.fill) ctx.fillStyle = rgbToCss(item.fill);
  if (item.stroke) {
    ctx.strokeStyle = rgbToCss(item.stroke);
    ctx.lineWidth = Math.max(0.05, fontSize / 20);
  }

  const charDirection = ((item.charDirection % 360) + 360) % 360;
  const readDirection = ((item.readDirection % 360) + 360) % 360;
  const chars = [...item.text];

  // Guard against documents whose declared advances are far narrower than the glyphs the
  // browser actually draws (common with substituted fonts). Without this the text run
  // piles up on itself, which is worse than slightly wide spacing.
  if (readDirection === 0 || readDirection === 180) {
    const declared = item.deltaX;
    if (declared && declared.length > 0) {
      const total = declared.slice(0, chars.length).reduce((sum, step) => sum + step, 0);
      if (total > 0) {
        const measured = ctx.measureText(item.text).width;
        if (measured > total * 1.12) {
          const factor = measured / total;
          item = { ...item, deltaX: declared.map((step) => step * factor) };
        }
      }
    }
  }

  // Vertical text (ReadDirection 90/270): characters advance downwards.
  if (readDirection === 90 || readDirection === 270) {
    // CharDirection describes the glyph baseline: 0 means upright, ±90 rotates the glyph.
    // Vertical layout implies a 90° glyph rotation, so take the larger of the two.
    let glyphAngle = (charDirection * Math.PI) / 180;
    if (glyphAngle === 0) glyphAngle = readDirection === 90 ? Math.PI / 2 : -Math.PI / 2;

    ctx.save();
    ctx.translate(item.box.x + item.offsetX, item.box.y + item.offsetY);
    ctx.rotate(glyphAngle);
    if (item.hScale !== 1) ctx.scale(item.hScale, 1);

    let advance = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const step = item.deltaY?.[i] ?? item.deltaX?.[i] ?? item.size * GLYPH_ADVANCE_RATIO;
      ctx.fillText(chars[i], 0, advance);
      if (item.stroke) ctx.strokeText(chars[i], 0, advance);
      advance += step;
    }
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(item.box.x + item.offsetX, item.box.y + item.offsetY);
  if (item.hScale !== 1) ctx.scale(item.hScale, 1);

  let advance = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const step = item.deltaX?.[i] ?? item.size * GLYPH_ADVANCE_RATIO;
    if (charDirection === 0) {
      ctx.fillText(chars[i], advance, 0);
      if (item.stroke) ctx.strokeText(chars[i], advance, 0);
    } else {
      ctx.save();
      ctx.translate(advance, 0);
      ctx.rotate((charDirection * Math.PI) / 180);
      ctx.fillText(chars[i], 0, 0);
      if (item.stroke) ctx.strokeText(chars[i], 0, 0);
      ctx.restore();
    }
    advance += step;
  }
  ctx.restore();
}

function drawPath(ctx: CanvasRenderingContext2D, item: PathItem): void {
  ctx.beginPath();
  let open = false;
  for (const command of item.commands) {
    switch (command.type) {
      case 'M':
        ctx.moveTo(command.x, command.y);
        open = true;
        break;
      case 'L':
        if (!open) {
          ctx.moveTo(command.x, command.y);
          open = true;
        } else {
          ctx.lineTo(command.x, command.y);
        }
        break;
      case 'C':
        ctx.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
        break;
      case 'Q':
        ctx.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
        break;
      case 'Z':
        ctx.closePath();
        break;
      default:
        break;
    }
  }

  if (item.fill) {
    ctx.fillStyle = rgbToCss(item.fill);
    ctx.fill('evenodd');
  }
  if (item.stroke) {
    ctx.strokeStyle = rgbToCss(item.stroke);
    ctx.lineWidth = Math.max(0.02, item.lineWidth);
    ctx.lineCap = item.lineCap as CanvasLineCap;
    ctx.lineJoin = item.lineJoin as CanvasLineJoin;
    if (item.dash) ctx.setLineDash(item.dash);
    ctx.stroke();
    if (item.dash) ctx.setLineDash([]);
  }
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  item: ImageItem,
  bitmap: CanvasImageSource,
): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // The Boundary rectangle is the placement box in page millimetres. A CTM on an image is
  // usually a redundant scale that mirrors the Boundary (applying it would square the
  // size), so only its rotation component is meaningful here.
  const angle = rotationOf(item.ctm);
  if (angle === 0) {
    ctx.drawImage(bitmap, item.box.x, item.box.y, item.box.width, item.box.height);
    return;
  }

  const cx = item.box.x + item.box.width / 2;
  const cy = item.box.y + item.box.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.drawImage(bitmap, -item.box.width / 2, -item.box.height / 2, item.box.width, item.box.height);
  ctx.translate(-cx, -cy);
}

function drawItems(
  ctx: CanvasRenderingContext2D,
  items: RenderItem[],
  images: ImageProvider,
  pending: Set<string>,
): void {
  for (const item of items) {
    switch (item.kind) {
      case 'group': {
        const group = item as GroupItem;
        ctx.save();
        applyMatrix(ctx, group.ctm);
        drawItems(ctx, group.children, images, pending);
        ctx.restore();
        break;
      }
      case 'image': {
        const bitmap = images.get(item.resourceId);
        if (!bitmap) {
          pending.add(item.resourceId);
          break;
        }
        // No ctx.save/transform here: `drawImage` sizes the bitmap to the Boundary box and
        // applies only the rotation embedded in the CTM (see drawImage).
        drawImage(ctx, item, bitmap);
        break;
      }
      case 'path': {
        ctx.save();
        applyMatrix(ctx, item.ctm);
        drawPath(ctx, item);
        ctx.restore();
        break;
      }
      case 'text': {
        ctx.save();
        if (item.ctm) applyMatrix(ctx, item.ctm);
        drawText(ctx, item);
        ctx.restore();
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Render a page onto a canvas, resizing the canvas buffer as needed.
 *
 * Rendering is synchronous once bitmaps are decoded; IDs that are still loading are
 * reported in `pending` (and were requested through the provider).
 */
export function renderPageToCanvas(
  canvas: HTMLCanvasElement,
  page: ParsedPage,
  options: RenderOptions,
): RenderResult {
  const { pxPerMm, images } = options;
  const size = canvasSizeFor(page.width, page.height, pxPerMm);

  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { width: size.width, height: size.height, pending: [], clamped: size.clamped };
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();

  // One mm→px scale for the whole page; all drawing stays in millimetres.
  // Use the clamped size so the page still fits the canvas exactly.
  const density = size.width / page.width;
  ctx.scale(density, density);

  const pending = new Set<string>();
  drawItems(ctx, page.items, images, pending);
  ctx.restore();

  return { width: size.width, height: size.height, pending: [...pending], clamped: size.clamped };
}

export type { ParsedPage };
