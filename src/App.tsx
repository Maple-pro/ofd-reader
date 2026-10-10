import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './components/EmptyState';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/Viewport';
import { useOfdDocument } from './hooks/useOfdDocument';
import { viewerActions, useViewerState } from './state/viewerStore';

export default function App() {
  const { doc, loading, progress, error, open, close } = useOfdDocument();
  const viewerDoc = useViewerState().doc;
  const [fatal, setFatal] = useState<string | null>(null);

  // Push the loaded document into the viewer store.
  useEffect(() => {
    if (doc) viewerActions.setDocument(doc);
    else viewerActions.setDocument(null);
  }, [doc]);

  const handleOpen = useCallback(
    (file: File) => {
      setFatal(null);
      void open(file);
    },
    [open],
  );

  const handleClose = useCallback(() => {
    viewerActions.setDocument(null);
    close();
  }, [close]);

  /**
   * Optional deep link: `?src=<url>` opens a document automatically.
   *
   * Useful for bookmarking a hosted scan, and for automated smoke tests. The fetch is
   * skipped on `file://`, where cross-origin reads are always blocked.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (!src) return;
    if (window.location.protocol === 'file:') {
      setFatal('通过 file:// 打开页面时无法自动加载 src 参数，请用本地服务器地址或手动选择文件。');
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size < 1024 && blob.type.includes('text/html')) {
          throw new Error('该地址返回的是网页而不是 OFD 文件');
        }
        const fileName = decodeURIComponent(src.split('/').pop() ?? 'document.ofd');
        handleOpen(new File([blob], fileName, { type: blob.type || 'application/ofd' }));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setFatal(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => controller.abort();
  }, [handleOpen]);

  // Document-level keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!viewerDoc) return;

      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          viewerActions.nextPage();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          viewerActions.previousPage();
          break;
        case 'Home':
          event.preventDefault();
          viewerActions.goToPage(0);
          break;
        case 'End':
          event.preventDefault();
          viewerActions.goToPage(viewerDoc.pageCount - 1);
          break;
        default:
          break;
      }
      if (!event.ctrlKey && !event.metaKey && (event.key === 'o' || event.key === 'O')) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('.toolbar .btn.primary')?.click();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewerDoc]);

  // Surface unexpected runtime failures instead of showing a blank page.
  useEffect(() => {
    const onError = (event: ErrorEvent) => setFatal(event.message);
    window.addEventListener('error', onError);
    return () => window.removeEventListener('error', onError);
  }, []);

  return (
    <div className="app">
      <Toolbar onOpenFile={handleOpen} onClose={handleClose} busy={loading} />
      {viewerDoc ? (
        <Viewport />
      ) : (
        <EmptyState onOpenFile={handleOpen} loading={loading} progress={progress} error={error} />
      )}
      {fatal ? (
        <div className="fatal-banner" role="alert">
          运行时错误：{fatal}
          <button type="button" className="btn ghost small" onClick={() => setFatal(null)}>
            忽略
          </button>
        </div>
      ) : null}
    </div>
  );
}
