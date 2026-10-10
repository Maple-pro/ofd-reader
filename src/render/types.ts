/**
 * Geometry primitives and intermediate representation (IR) for OFD page content.
 *
 * Coordinate system: millimetres, origin at the top-left of the page's PhysicalBox.
 * OFD stores every geometric value in mm; the renderer converts to CSS pixels with a
 * single `pxPerMm` factor so that output is resolution independent.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [a b c d e f] — x' = a*x + c*y + e, y' = b*x + d*y + f (same order as ctx.transform). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  alpha: number;
}

export interface ImageItem {
  kind: 'image';
  resourceId: string;
  /** Placement rectangle in mm (Boundary). */
  box: Box;
  ctm: Matrix;
  /** True when Boundary/CTM covers essentially the whole page (scanned page). */
  fullPage: boolean;
}

export interface PathItem {
  kind: 'path';
  /** Commands in absolute mm coordinates (already resolved, M/L/C/Q/Z). */
  commands: PathCommand[];
  ctm: Matrix;
  fill: RgbColor | null;
  stroke: RgbColor | null;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  dash: number[] | null;
}

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

export interface TextItem {
  kind: 'text';
  text: string;
  /** Top-left of the text object's Boundary box, in mm. */
  box: Box;
  ctm: Matrix | null;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** Font size in mm. */
  size: number;
  fill: RgbColor | null;
  stroke: RgbColor | null;
  alpha: number;
  readDirection: number;
  charDirection: number;
  hScale: number;
  /** Per-character advances in mm; already expanded from "g N X" notation. */
  deltaX: number[] | null;
  deltaY: number[] | null;
  /** TextCode X/Y offsets in mm. */
  offsetX: number;
  offsetY: number;
}

export interface GroupItem {
  kind: 'group';
  ctm: Matrix;
  children: RenderItem[];
}

export type RenderItem = ImageItem | PathItem | TextItem | GroupItem;

export interface ParsedPage {
  index: number;
  /** PhysicalBox size in mm. */
  width: number;
  height: number;
  items: RenderItem[];
  /** Set when the page is a single full-page image (scanned page). */
  scan: ImageItem | null;
}

/** A drawing surface: either the on-screen canvas or an offscreen buffer. */
export interface Surface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

/** Convert a matrix string ("a b c d e f") to a Matrix, or null when absent/invalid. */
export function parseMatrix(value: unknown): Matrix | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
}

/** Parse a "x y width height" string into a Box (mm). */
export function parseBox(value: unknown): Box {
  if (typeof value !== 'string') return { x: 0, y: 0, width: 0, height: 0 };
  const parts = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** Multiply two 2D affine matrices (row-vector convention, matching ctx.transform). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Apply a matrix to a point. */
export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function isIdentity(m: Matrix, epsilon = 1e-6): boolean {
  return (
    Math.abs(m[0] - 1) < epsilon &&
    Math.abs(m[1]) < epsilon &&
    Math.abs(m[2]) < epsilon &&
    Math.abs(m[3] - 1) < epsilon &&
    Math.abs(m[4]) < epsilon &&
    Math.abs(m[5]) < epsilon
  );
}

/** CSS colour string for a parsed OFD colour. */
export function rgbToCss(color: RgbColor): string {
  return `rgba(${color.r},${color.g},${color.b},${color.alpha})`;
}
