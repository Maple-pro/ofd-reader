import { useRef } from 'react';
import { cssPixelsPerMm } from '../hooks/useViewTransform';
import { useViewerState, viewerActions } from '../state/viewerStore';
import { downloadPage, printPages } from '../lib/export';

interface ToolbarProps {
  onOpenFile: (file: File) => void;
  onClose: () => void;
  busy: boolean;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function Toolbar({ onOpenFile, onClose, busy }: ToolbarProps) {
  const { doc, page, zoomMode, effectiveScale, rotation, outlineOpen } = useViewerState();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const total = doc?.pageCount ?? 0;
  const percent = Math.round((effectiveScale / cssPixelsPerMm()) * 100);

  const pickFile = () => inputRef.current?.click();

  const nextZoomStep = (direction: 1 | -1) => {
    const current = effectiveScale / cssPixelsPerMm();
    const sorted = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
    const next =
      sorted.find((step) => (direction > 0 ? step > current + 0.001 : step < current - 0.001)) ??
      current;
    viewerActions.setZoomScale(next * cssPixelsPerMm());
  };

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="btn primary" onClick={pickFile} disabled={busy}>
          打开 OFD
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".ofd,application/ofd"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onOpenFile(file);
            event.target.value = '';
          }}
        />
        {doc ? (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
            <span className="doc-name" title={doc.name}>
              {doc.name}
            </span>
          </>
        ) : (
          <span className="doc-name muted">未打开文件</span>
        )}
      </div>

      {doc ? (
        <>
          <div className="toolbar-group center">
            <button
              type="button"
              className="btn icon"
              title="第一页 (Home)"
              onClick={() => viewerActions.goToPage(0)}
              disabled={page === 0}
            >
              «
            </button>
            <button
              type="button"
              className="btn icon"
              title="上一页 (←)"
              onClick={viewerActions.previousPage}
              disabled={page === 0}
            >
              ‹
            </button>
            <span className="page-indicator">
              <input
                type="number"
                min={1}
                max={total}
                value={page + 1}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) viewerActions.goToPage(value - 1);
                }}
              />
              <span className="muted"> / {total}</span>
            </span>
            <button
              type="button"
              className="btn icon"
              title="下一页 (→)"
              onClick={viewerActions.nextPage}
              disabled={page >= total - 1}
            >
              ›
            </button>
            <button
              type="button"
              className="btn icon"
              title="最后一页 (End)"
              onClick={() => viewerActions.goToPage(total - 1)}
              disabled={page >= total - 1}
            >
              »
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={`btn ghost${outlineOpen ? ' active' : ''}`}
              title="显示/隐藏缩略图"
              onClick={viewerActions.toggleOutline}
            >
              缩略图
            </button>
            <button type="button" className="btn icon" title="缩小 (Ctrl+-)" onClick={() => nextZoomStep(-1)}>
              −
            </button>
            <button
              type="button"
              className="btn ghost zoom-value"
              title="实际大小 (Ctrl+0)"
              onClick={() => viewerActions.setZoomMode('actual')}
            >
              {percent}%
            </button>
            <button type="button" className="btn icon" title="放大 (Ctrl++)" onClick={() => nextZoomStep(1)}>
              +
            </button>
            <button
              type="button"
              className={`btn ghost${zoomMode === 'fit-width' ? ' active' : ''}`}
              title="适合宽度"
              onClick={() => viewerActions.setZoomMode('fit-width')}
            >
              适合宽度
            </button>
            <button
              type="button"
              className={`btn ghost${zoomMode === 'fit-page' ? ' active' : ''}`}
              title="适合页面"
              onClick={() => viewerActions.setZoomMode('fit-page')}
            >
              适合页面
            </button>
            <button
              type="button"
              className="btn icon"
              title="向左旋转 90°"
              onClick={() => viewerActions.rotate(-90)}
            >
              ↺
            </button>
            <button
              type="button"
              className="btn icon"
              title="向右旋转 90°"
              onClick={() => viewerActions.rotate(90)}
            >
              ↻
            </button>
            <span className="muted small">{rotation}°</span>
            <button
              type="button"
              className="btn ghost"
              title="下载当前页为图片"
              onClick={() => {
                if (doc) void downloadPage(doc, page, { dpi: 200 });
              }}
            >
              导出图片
            </button>
            <button
              type="button"
              className="btn ghost"
              title="打印整份文档"
              onClick={() => {
                if (!doc) return;
                void printPages(doc, Array.from({ length: doc.pageCount }, (_, i) => i));
              }}
            >
              打印
            </button>
          </div>
        </>
      ) : null}
    </header>
  );
}
