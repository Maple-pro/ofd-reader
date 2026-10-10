import { useEffect, useRef, useState } from 'react';
import { renderPageToCanvas } from '../render/renderer';
import type { ParsedPage } from '../render/types';
import type { OfdDocument } from '../lib/types';

export interface PageCanvasProps {
  doc: OfdDocument;
  index: number;
  /** Page size in mm from the document metadata (available before parsing). */
  widthMm: number;
  heightMm: number;
  /** Device independent output density in px/mm. */
  pxPerMm: number;
  /** Rotation in degrees: 0 | 90 | 180 | 270. */
  rotation?: number;
  /** Fit inside the parent instead of rendering the standalone page frame. */
  decorative?: boolean;
  className?: string;
  onStateChange?: (state: PageCanvasState) => void;
}

export interface PageCanvasState {
  status: 'loading' | 'ready' | 'error';
  message?: string;
  /** True while image resources for this page are still being decoded. */
  pendingImages: boolean;
}

/**
 * Renders a single OFD page to a canvas at the requested density.
 *
 * Pages are parsed on demand (and cached by the document), so zooming never re-parses.
 * Image bitmaps are decoded lazily; a store subscription repaints the page when they
 * arrive, which keeps large scanned documents responsive.
 */
export function PageCanvas({
  doc,
  index,
  widthMm,
  heightMm,
  pxPerMm,
  rotation = 0,
  decorative = false,
  className,
  onStateChange,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<ParsedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState(false);
  const [repaintToken, setRepaintToken] = useState(0);

  // Parse (or fetch from the cache) the page whenever the index changes.
  // `page` is the single source of truth: a page object is always rendered for the index
  // it was parsed for, which keeps this effect idempotent under StrictMode double-runs.
  useEffect(() => {
    let cancelled = false;
    setError(null);

    const cached = doc.peekPage(index);
    if (cached) {
      setPage(cached);
      return () => {
        cancelled = true;
      };
    }

    setPage(null);
    doc
      .loadPage(index)
      .then((parsed) => {
        if (cancelled) return;
        setPage(parsed);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [doc, index]);

  // Repaint as soon as a lazily decoded bitmap becomes available.
  useEffect(() => doc.images.subscribe(() => setRepaintToken((token) => token + 1)), [doc]);

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page || page.index !== index || error) return;

    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const result = renderPageToCanvas(canvas, page, {
      pxPerMm: pxPerMm * dpr,
      images: doc.images,
    });

    // The canvas buffer is dpr× the CSS size; scale it back down for display.
    canvas.style.width = `${result.width / dpr}px`;
    canvas.style.height = `${result.height / dpr}px`;
    setPendingImages(result.pending.length > 0);
  }, [page, index, pxPerMm, repaintToken, doc, error]);

  // Report status to the parent (page indicator / "still decoding" hint).
  useEffect(() => {
    if (!onStateChange) return;
    if (error) {
      onStateChange({ status: 'error', message: error, pendingImages: false });
      return;
    }
    if (!page || page.index !== index) {
      onStateChange({ status: 'loading', pendingImages: false });
      return;
    }
    onStateChange({ status: 'ready', pendingImages });
  }, [error, page, index, pendingImages, onStateChange]);

  if (decorative) {
    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: 'block',
          width: `${Math.round(widthMm * pxPerMm)}px`,
          height: `${Math.round(heightMm * pxPerMm)}px`,
          margin: '0 auto',
        }}
      />
    );
  }

  const rotated = rotation % 180 === 0;
  // The wrapper must swap its box for 90°/270° so the rotated page still fits its slot.
  const wrapperWidth = Math.round((rotated ? widthMm : heightMm) * pxPerMm);
  const wrapperHeight = Math.round((rotated ? heightMm : widthMm) * pxPerMm);

  return (
    <div
      className={className}
      style={{
        width: `${wrapperWidth}px`,
        height: `${wrapperHeight}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transformOrigin: 'center center',
        }}
      >
        {error ? (
          <div className="page-error">
            <strong>无法渲染第 {index + 1} 页</strong>
            <span>{error}</span>
          </div>
        ) : (
          <canvas ref={canvasRef} />
        )}
      </div>
    </div>
  );
}
