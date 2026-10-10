import { useEffect, useRef, useState } from 'react';
import type { LoadProgress } from '../lib/types';

interface EmptyStateProps {
  onOpenFile: (file: File) => void;
  loading: boolean;
  progress: LoadProgress | null;
  error: string | null;
}

/** Landing screen: drop zone, file picker and a short description. */
export function EmptyState({ onOpenFile, loading, progress, error }: EmptyStateProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) onOpenFile(file);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onOpenFile]);

  return (
    <div className={`empty${dragging ? ' dragging' : ''}`}>
      <div className="empty-card">
        <h1>OFD 阅读器</h1>
        <p className="lead">
          在浏览器中直接打开 OFD 文件（GB/T 33190-2016），针对扫描件优化：整页图片按需解码，
          百页文档也能流畅翻页。
        </p>

        <button
          type="button"
          className="btn primary large"
          onClick={() => inputRef.current?.click()}
          disabled={loading}
        >
          选择 OFD 文件
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
        <p className="hint">也可以把 .ofd 文件拖到此处；文件不会上传，全部在本地解析。</p>

        {loading ? (
          <div className="progress">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }}
              />
            </div>
            <span>{progress?.message ?? '解析中…'}</span>
          </div>
        ) : null}

        {error ? (
          <div className="error-box">
            <strong>打开失败</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <ul className="feature-list">
          <li>支持整页扫描件（JPEG/PNG 内嵌图片），原图分辨率渲染</li>
          <li>支持文字、矢量图形、模板页与印章等内容</li>
          <li>缩放、旋转、缩略图导航、导出图片、打印</li>
        </ul>
      </div>
    </div>
  );
}
