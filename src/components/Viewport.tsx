import { useCallback, useEffect, useRef, useState } from 'react';
import { PageCanvas, type PageCanvasState } from './PageCanvas';
import { OutlineRail } from './OutlineRail';
import {
  clampScale,
  computeGeometry,
  cssPixelsPerMm,
  useElementSize,
} from '../hooks/useViewTransform';
import { useViewerState, viewerActions } from '../state/viewerStore';
import { printPages } from '../lib/export';


export function Viewport() {
  const { doc, page: pageIndex, zoomMode, customScale, rotation, outlineOpen } = useViewerState();
  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<PageCanvasState>({ status: 'loading', pendingImages: false });
  const panRef = useRef(pan);
  panRef.current = pan;
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const meta = doc?.pages[pageIndex];
  const widthMm = meta?.width ?? 210;
  const heightMm = meta?.height ?? 297;

  const geometry = computeGeometry(
    widthMm,
    heightMm,
    rotation,
    // `useElementSize` reports the padding-free content box, which is exactly the space
    // available for the page — no extra padding subtraction here.
    stageSize,
    { mode: zoomMode, scale: customScale, rotation },
  );

  // Publish the effective scale so the toolbar can show a percentage.
  useEffect(() => {
    viewerActions.reportGeometry(geometry.pxPerMm, geometry.fitWidthScale, geometry.fitPageScale);
  }, [geometry.pxPerMm, geometry.fitWidthScale, geometry.fitPageScale]);

  // Reset pan when the page, zoom mode or rotation changes.
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [pageIndex, zoomMode, rotation, doc]);

  const fitToViewport = useCallback(() => {
    viewerActions.setZoomMode('fit-width');
  }, []);

  const fitPage = useCallback(() => {
    viewerActions.setZoomMode('fit-page');
  }, []);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY / 400);
        const next = clampScale(geometry.pxPerMm * factor);
        const rect = event.currentTarget.getBoundingClientRect();
        const pointerX = event.clientX - (rect.left + rect.width / 2 + panRef.current.x);
        const pointerY = event.clientY - (rect.top + rect.height / 2 + panRef.current.y);
        const ratio = next / geometry.pxPerMm;
        setPan({
          x: panRef.current.x - pointerX * (ratio - 1),
          y: panRef.current.y - pointerY * (ratio - 1),
        });
        viewerActions.setZoomScale(next);
        return;
      }

      // Plain wheel events fall through to normal scrolling (the page area can be scrolled
      // once it is larger than the stage); dragging is the primary way to pan.
    },
    [geometry.pxPerMm],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button, and never when the click lands on a control.
    if (event.button !== 0) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({
      x: drag.panX + (event.clientX - drag.x),
      y: drag.panY + (event.clientY - drag.y),
    });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          viewerActions.setZoomScale(clampScale(geometry.pxPerMm * 1.2));
        } else if (event.key === '-') {
          event.preventDefault();
          viewerActions.setZoomScale(clampScale(geometry.pxPerMm / 1.2));
        } else if (event.key === '0') {
          event.preventDefault();
          fitToViewport();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [geometry.pxPerMm, fitToViewport]);

  if (!doc) return null;

  const scanned = meta?.scanned ?? false;

  return (
    <div className="workspace">
      {outlineOpen ? <OutlineRail doc={doc} /> : null}

      <main className="stage-wrap">
        <div
          className={`stage${dragging ? ' dragging' : ''}`}
          ref={stageRef}
          onWheel={handleWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={fitPage}
          tabIndex={0}
          role="region"
          aria-label="页面视图"
        >
          <div
            className="page-positioner"
            style={{
              transform: `translate(${Math.round(pan.x)}px, ${Math.round(pan.y)}px)`,
            }}
          >
            <div className="page-shadow">
              <PageCanvas
                doc={doc}
                index={pageIndex}
                widthMm={widthMm}
                heightMm={heightMm}
                pxPerMm={geometry.pxPerMm}
                rotation={rotation}
                onStateChange={setStatus}
              />
            </div>
          </div>
        </div>

        <footer className="statusbar">
          <span>
            第 {pageIndex + 1} / {doc.pageCount} 页
          </span>
          <span>
            {geometry.widthMm.toFixed(1)} × {geometry.heightMm.toFixed(1)} mm
          </span>
          <span>
            缩放 {Math.round((geometry.pxPerMm / cssPixelsPerMm()) * 100)}%
          </span>
          <span>{scanned ? '扫描件' : '版式内容'}</span>
          {status.status === 'loading' ? <span className="muted">解析页面…</span> : null}
          {status.status === 'ready' && status.pendingImages ? (
            <span className="muted">正在解码图片…</span>
          ) : null}
          {status.status === 'error' ? <span className="error">{status.message}</span> : null}
          <span className="spacer" />
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void printPages(doc, [pageIndex], { dpi: 200 })}
          >
            打印本页
          </button>
          <span className="muted small">Ctrl+滚轮缩放 · 按住拖动平移 · 双击适合页面</span>
        </footer>
      </main>
    </div>
  );
}
