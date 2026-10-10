/**
 * Page XML → render IR.
 *
 * Page content is parsed from the page XML directly so that `AbbreviatedData` — the path
 * notation used by vector content such as invoices, forms and stamps — is preserved.
 * (The reference JS OFD reader drops it and can only draw rectangles.)
 * Container-level parsing lives in `container.ts`.
 *
 * Every geometric value is kept in millimetres; unit conversion happens in the renderer.
 */

import { parseAbbreviatedData } from '../render/paths';
import {
  IDENTITY,
  parseBox,
  parseMatrix,
  type Box,
  type GroupItem,
  type ImageItem,
  type Matrix,
  type ParsedPage,
  type PathCommand,
  type PathItem,
  type RenderItem,
  type RgbColor,
  type TextItem,
} from '../render/types';
import type { FontEntry } from './resources';

const DEFAULT_LINE_WIDTH = 0.3;
const DEFAULT_FONT_SIZE = 3;
const SCAN_AREA_RATIO = 0.97;
const EPSILON = 1e-3;

/* ------------------------------------------------------------------ *
 * Namespace-agnostic DOM helpers
 * ------------------------------------------------------------------ */

/**
 * Local element name without any namespace prefix.
 *
 * The prefix must be stripped explicitly: not every DOM implementation fills `localName`
 * with the local part for XML documents (linkedom keeps `ofd:Page` there), and OFD
 * producers are inconsistent about the prefix and its casing.
 */
function tagOf(el: Element): string {
  const name = el.localName || el.nodeName || '';
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function childOf(parent: Element, name: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (tagOf(child) === name) return child;
  }
  return null;
}

function childrenOf(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => tagOf(child) === name);
}

/** Depth-first search for a descendant with the given local name. */
function descendantOf(parent: Element, name: string): Element | null {
  const visit = (element: Element): Element | null => {
    for (const child of Array.from(element.children)) {
      if (tagOf(child) === name) return child;
      const nested = visit(child);
      if (nested) return nested;
    }
    return null;
  };
  return visit(parent);
}

function str(el: Element | null, name: string): string | undefined {
  const value = el?.getAttribute(name);
  return value === null || value === undefined ? undefined : value;
}

function num(el: Element | null, name: string, fallback = 0): number {
  const raw = str(el, name);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(el: Element | null, name: string): boolean | null {
  const raw = str(el, name);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/** Parse an OFD colour value: "128 0 0", "#ee #20 #25", "255 0 0". */
function parseColorValue(value: string, alpha: number | null): RgbColor {
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean);
  const channel = (token: string | undefined): number => {
    if (!token) return 0;
    const parsed = token.startsWith('#') ? parseInt(token.slice(1), 16) : parseInt(token, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : 0;
  };
  return {
    r: channel(tokens[0]),
    g: channel(tokens[1]),
    b: channel(tokens[2]),
    alpha: alpha === null ? 1 : Math.max(0, Math.min(1, alpha / 255)),
  };
}

function readColor(el: Element, colorTag: string): RgbColor | null {
  const colorEl = childOf(el, colorTag);
  if (!colorEl) return null;
  const value = str(colorEl, 'Value');
  if (!value) return null;
  const alphaRaw = str(colorEl, 'Alpha');
  const alpha = alphaRaw !== undefined && alphaRaw !== '' ? Number(alphaRaw) : null;
  return parseColorValue(value, Number.isFinite(alpha as number) ? (alpha as number) : null);
}

function matrixOf(el: Element | null): Matrix {
  return parseMatrix(str(el, 'CTM')) ?? IDENTITY;
}

function isAxisAligned(m: Matrix): boolean {
  return Math.abs(m[1]) < EPSILON && Math.abs(m[2]) < EPSILON;
}

function rectangleCommands(box: Box): PathCommand[] {
  return [
    { type: 'M', x: box.x, y: box.y },
    { type: 'L', x: box.x + box.width, y: box.y },
    { type: 'L', x: box.x + box.width, y: box.y + box.height },
    { type: 'L', x: box.x, y: box.y + box.height },
    { type: 'Z' },
  ];
}

/* ------------------------------------------------------------------ *
 * Delta notation
 * ------------------------------------------------------------------ */

/**
 * Expand OFD delta notation into per-character advances in mm.
 *
 * Forms: `1.5 1.5 1.5` (one advance per character), `g` (glyph width = font size) and
 * `g 4 3` (3 repeated 4×). Bare `4 3` is not treated as a repeat: it is indistinguishable
 * from two ordinary advances, and misreading it would shift a whole text run.
 */
export function expandDelta(value: string | undefined, fontSize: number): number[] | null {
  if (!value) return null;
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const isNumber = (token: string | undefined): boolean =>
    token !== undefined && token !== '' && Number.isFinite(Number(token));

  const out: number[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === 'g') {
      if (isNumber(tokens[i + 1]) && isNumber(tokens[i + 2])) {
        const count = Math.max(0, Math.min(100000, Math.round(Number(tokens[i + 1]))));
        const step = Number(tokens[i + 2]);
        for (let k = 0; k < count; k += 1) out.push(step);
        i += 3;
        continue;
      }
      out.push(fontSize);
      i += 1;
      continue;
    }

    if (isNumber(token)) {
      // Any other numeric token is a single advance. Repeat notation without the "g"
      // marker is ambiguous with ordinary fractional advances, so it is not guessed at.
      out.push(Number(token));
      i += 1;
      continue;
    }

    i += 1;
  }

  return out.length > 0 ? out : null;
}

/* ------------------------------------------------------------------ *
 * Element converters
 * ------------------------------------------------------------------ */

function convertImage(el: Element): ImageItem | null {
  const resourceId = str(el, 'ResourceID') ?? str(el, 'ResourceId');
  if (!resourceId) return null;
  return {
    kind: 'image',
    resourceId,
    box: parseBox(str(el, 'Boundary')),
    ctm: matrixOf(el),
    fullPage: false,
  };
}

function convertPath(el: Element): PathItem {
  const box = parseBox(str(el, 'Boundary'));
  const dataEl = childOf(el, 'AbbreviatedData') ?? descendantOf(el, 'AbbreviatedData');
  const data = dataEl?.textContent ?? '';
  const parsed = data.trim() ? parseAbbreviatedData(data) : null;
  const commands = parsed ?? rectangleCommands(box);

  const strokeColor = readColor(el, 'StrokeColor');
  const fillColor = readColor(el, 'FillColor');
  const strokeFlag = bool(el, 'Stroke');
  const fillFlag = bool(el, 'Fill');

  let fill: RgbColor | null = null;
  if (fillFlag !== false) fill = fillColor ?? (fillFlag === true ? parseColorValue('0 0 0', null) : null);

  let stroke: RgbColor | null = null;
  if (strokeFlag !== false) {
    stroke = strokeColor ?? (strokeFlag === true ? parseColorValue('0 0 0', null) : null);
    // Some producers omit Stroke="true" but set StrokeColor explicitly.
    if (!stroke && strokeFlag === null && fill === null) stroke = parseColorValue('0 0 0', null);
  }

  const lineWidthRaw = num(el, 'LineWidth', 0);
  const dashRaw = str(el, 'DashPattern');
  const dash = dashRaw
    ? dashRaw
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0)
    : [];

  return {
    kind: 'path',
    commands,
    ctm: matrixOf(el),
    fill: fill && fill.alpha > 0 ? fill : null,
    stroke: stroke && stroke.alpha > 0 ? stroke : null,
    lineWidth: lineWidthRaw > 0 ? lineWidthRaw : DEFAULT_LINE_WIDTH,
    lineCap: str(el, 'Cap') === 'Round' ? 'round' : str(el, 'Cap') === 'Square' ? 'square' : 'butt',
    lineJoin:
      str(el, 'Join') === 'Round' ? 'round' : str(el, 'Join') === 'Bevel' ? 'bevel' : 'miter',
    dash: dash.length > 0 ? dash : null,
  };
}

function convertText(el: Element, fonts: Map<string, FontEntry>): TextItem | null {
  const textCode = childOf(el, 'TextCode') ?? descendantOf(el, 'TextCode');
  const text = textCode?.textContent ?? '';
  if (!text) return null;

  const fontIdRaw = str(el, 'Font');
  const font = fontIdRaw ? fonts.get(fontIdRaw) : undefined;

  const size = num(el, 'Size', 0) || DEFAULT_FONT_SIZE;
  const fillColor = readColor(el, 'FillColor');
  const strokeColor = readColor(el, 'StrokeColor');
  const strokeFlag = bool(el, 'Stroke');
  const alphaRaw = str(el, 'Alpha');
  const alpha = alphaRaw !== undefined && Number.isFinite(Number(alphaRaw)) ? Number(alphaRaw) / 255 : 1;

  const weight = num(el, 'Weight', 0);
  return {
    kind: 'text',
    text,
    box: parseBox(str(el, 'Boundary')),
    ctm: parseMatrix(str(el, 'CTM')),
    fontFamily: font?.family ?? 'sans-serif',
    fontWeight: weight > 0 ? Math.max(100, Math.min(900, weight)) : font?.bold ? 700 : 400,
    italic: bool(el, 'Italic') === true || font?.italic === true,
    size,
    fill: fillColor ?? parseColorValue('0 0 0', null),
    stroke: strokeFlag === true ? strokeColor ?? fillColor : null,
    alpha: Math.max(0, Math.min(1, alpha)),
    readDirection: num(el, 'ReadDirection', 0),
    charDirection: num(el, 'CharDirection', 0),
    hScale: num(el, 'HScale', 1) || 1,
    deltaX: expandDelta(str(textCode, 'DeltaX'), size),
    deltaY: expandDelta(str(textCode, 'DeltaY'), size),
    offsetX: num(textCode, 'X', 0),
    offsetY: num(textCode, 'Y', 0),
  };
}

function convertEvents(parent: Element, fonts: Map<string, FontEntry>, depth = 0): RenderItem[] {
  const items: RenderItem[] = [];
  if (depth > 24) return items;

  for (const el of Array.from(parent.children)) {
    switch (tagOf(el)) {
      case 'ImageObject': {
        const item = convertImage(el);
        if (item) items.push(item);
        break;
      }
      case 'PathObject': {
        items.push(convertPath(el));
        break;
      }
      case 'TextObject': {
        const item = convertText(el, fonts);
        if (item) items.push(item);
        break;
      }
      case 'Layer':
      case 'Content':
      case 'PageBlock':
      case 'CompositeObject': {
        // Containers: Layer holds page content directly, PageBlock/CompositeObject nest it.
        // Layer/Content are transparent; PageBlock/CompositeObject may carry a CTM.
        const nested = convertEvents(el, fonts, depth + 1);
        if (nested.length === 0) break;
        const ctm = parseMatrix(str(el, 'CTM'));
        if (tagOf(el) === 'PageBlock' || tagOf(el) === 'CompositeObject' || ctm) {
          const group: GroupItem = {
            kind: 'group',
            ctm: ctm ?? IDENTITY,
            children: nested,
          };
          items.push(group);
        } else {
          items.push(...nested);
        }
        break;
      }
      default:
        break;
    }
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/** A parsed template page, kept for Background/Foreground merging. */
export interface TemplatePages {
  get(id: string): Element | null;
}

/**
 * Page size from `<Area><PhysicalBox>0 0 210 297</PhysicalBox></Area>`.
 *
 * PhysicalBox is a child element (not an attribute) and holds `x y width height` in mm.
 * A few producers write it as an attribute instead, so both are accepted.
 */
function pageBox(
  pageEl: Element,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const areaEl = childOf(pageEl, 'Area');
  const raw = childOf(areaEl ?? pageEl, 'PhysicalBox')?.textContent ?? str(areaEl, 'PhysicalBox') ?? '';
  const box = parseBox(raw);
  if (box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  return fallback;
}

function scannedImage(items: RenderItem[], width: number, height: number): ImageItem | null {
  if (items.length !== 1) return null;
  const only = items[0];
  if (only.kind !== 'image') return null;
  const image = only;
  const { box, ctm } = image;
  if (box.width <= 0 || box.height <= 0) return null;
  const pageArea = width * height;
  if (pageArea <= 0) return null;
  if ((box.width * box.height) / pageArea < SCAN_AREA_RATIO) return null;
  if (!isAxisAligned(ctm)) return null;

  // The drawn extent must sit inside the page (allow 1.5mm of bleed).
  // Only rotation-free placements qualify: a rotated scan (see `rotationOf`) still
  // renders correctly, but is reported as ordinary content so the caller can apply the
  // transform instead of relying on a simple image placement.
  return Math.abs(ctm[1]) < EPSILON && Math.abs(ctm[2]) < EPSILON ? image : null;
}

/**
 * Rotation angle (radians) embedded in an OFD CTM.
 *
 * OFD writers commonly emit a scan's placement as `CTM="w 0 0 h 0 0"` — a pure scale that
 * duplicates the Boundary box and must not be applied on top of it (that would square the
 * size). Only the rotation component is meaningful for image placement, so it is extracted
 * and applied around the boundary rectangle.
 */
export function rotationOf(ctm: Matrix): number {
  return Math.atan2(ctm[1], ctm[0]);
}

/**
 * Build the render IR for a page.
 *
 * @param index page index (0-based)
 * @param pageEl parsed `<ofd:Page>` element
 * @param fonts font table from PublicRes.xml
 * @param options.templates parsed template pages keyed by TemplatePage ID
 * @param options.fallbackSize document-level PhysicalBox, used when a page omits Area
 */
export function parsePageElement(
  index: number,
  pageEl: Element,
  fonts: Map<string, FontEntry>,
  options: { fallbackSize: { width: number; height: number }; templates?: TemplatePages },
): ParsedPage {
  const { width, height } = pageBox(pageEl, options.fallbackSize);
  const items: RenderItem[] = [];

  const contentEl = childOf(pageEl, 'Content');
  const templateRefs = childrenOf(pageEl, 'Template');

  for (const ref of templateRefs) {
    if ((str(ref, 'ZOrder') ?? 'Background') !== 'Background') continue;
    const id = str(ref, 'TemplateID');
    const tpl = id ? options.templates?.get(id) : null;
    if (tpl) items.push(...convertEvents(tpl, fonts));
  }

  if (contentEl) items.push(...convertEvents(contentEl, fonts));

  for (const ref of templateRefs) {
    if (str(ref, 'ZOrder') !== 'Foreground') continue;
    const id = str(ref, 'TemplateID');
    const tpl = id ? options.templates?.get(id) : null;
    if (tpl) items.push(...convertEvents(tpl, fonts));
  }

  const scan = scannedImage(items, width, height);
  if (scan) scan.fullPage = true;

  return { index, width, height, items, scan };
}

/** Parse a page XML string into a DOM element. */
export function parseXmlElement(xml: string): Element {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror');
  if (parserError.length > 0) {
    const message = parserError[0].textContent?.trim() ?? 'unknown XML error';
    throw new Error(`页面 XML 解析失败: ${message}`);
  }
  const root = doc.documentElement;
  if (!root) throw new Error('页面 XML 为空');
  return root;
}
