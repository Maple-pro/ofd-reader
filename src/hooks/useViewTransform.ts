import { useCallback, useEffect, useRef, useState } from 'react';

export type ZoomMode = 'fit-width' | 'fit-page' | 'actual' | 'custom';

export interface ViewTransform {
  mode: ZoomMode;
  /** Scale when mode === 'custom'. */
  scale: number;
  /** Rotation in degrees: 0 | 90 | 180 | 270. */
  rotation: number;
}

export interface PageGeometry {
  /** Page size in mm, before rotation. */
  widthMm: number;
  heightMm: number;
  /** Rendered size in CSS pixels, after rotation and scale. */
  cssWidth: number;
  cssHeight: number;
  /** Effective scale: CSS pixels per millimetre. */
  pxPerMm: number;
  fitWidthScale: number;
  fitPageScale: number;
}

export function cssPixelsPerMm(dpi = 96): number {
  return dpi / 25.4;
}

/** Page size with the rotation applied (90°/270° swap the axes). */
export function rotatedSize(widthMm: number, heightMm: number, rotation: number) {
  return rotation % 180 === 0
    ? { widthMm, heightMm }
    : { widthMm: heightMm, heightMm: widthMm };
}

export function computeGeometry(
  widthMm: number,
  heightMm: number,
  rotation: number,
  viewport: { width: number; height: number },
  view: ViewTransform,
): PageGeometry {
  const rotated = rotatedSize(widthMm, heightMm, rotation);
  const available = { width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) };

  const fitWidthScale = available.width / rotated.widthMm;
  const fitPageScale = Math.min(
    available.width / rotated.widthMm,
    available.height / rotated.heightMm,
  );

  let pxPerMm: number;
  switch (view.mode) {
    case 'fit-width':
      pxPerMm = fitWidthScale;
      break;
    case 'fit-page':
      pxPerMm = fitPageScale;
      break;
    case 'actual':
      pxPerMm = cssPixelsPerMm();
      break;
    case 'custom':
    default:
      pxPerMm = view.scale;
      break;
  }

  return {
    widthMm,
    heightMm,
    cssWidth: Math.max(1, Math.round(rotated.widthMm * pxPerMm)),
    cssHeight: Math.max(1, Math.round(rotated.heightMm * pxPerMm)),
    pxPerMm,
    fitWidthScale,
    fitPageScale,
  };
}

/** Ratio between two zoom modes, used to switch from fit to custom on zoom gestures. */
export function scaleOf(
  geometry: PageGeometry,
  view: ViewTransform,
): number {
  if (view.mode === 'custom') return view.scale;
  if (view.mode === 'actual') return cssPixelsPerMm();
  if (view.mode === 'fit-width') return geometry.fitWidthScale;
  return geometry.fitPageScale;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Observe an element's content box. */
export function useElementSize<T extends HTMLElement>(): [
  import('react').RefObject<T | null>,
  Viewport,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Viewport>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      setSize((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height },
      );
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

export function useViewTransform(initial: Partial<ViewTransform> = {}) {
  const [view, setView] = useState<ViewTransform>({
    mode: 'fit-width',
    scale: 1,
    rotation: 0,
    ...initial,
  });

  const setMode = useCallback((mode: ZoomMode, scale?: number) => {
    setView((prev) => ({
      ...prev,
      mode,
      scale: scale ?? (mode === 'custom' ? prev.scale : prev.scale),
    }));
  }, []);

  const setCustomScale = useCallback((scale: number) => {
    setView((prev) => ({ ...prev, mode: 'custom', scale: clampScale(scale) }));
  }, []);

  const zoomBy = useCallback((factor: number, base: number) => {
    setView((prev) => ({ ...prev, mode: 'custom', scale: clampScale(base * factor) }));
  }, []);

  const rotate = useCallback((delta: number) => {
    setView((prev) => ({ ...prev, rotation: (((prev.rotation + delta) % 360) + 360) % 360 }));
  }, []);

  const reset = useCallback(() => setView((prev) => ({ ...prev, mode: 'fit-width', scale: 1, rotation: 0 })), []);

  return { view, setView, setMode, setCustomScale, zoomBy, rotate, reset };
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
