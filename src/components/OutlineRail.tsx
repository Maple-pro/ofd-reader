import { memo, useEffect, useRef } from 'react';
import { useIsVisible } from '../hooks/useIsVisible';
import { useViewerState, viewerActions } from '../state/viewerStore';
import { PageCanvas } from './PageCanvas';
import type { OfdDocument } from '../lib/types';

const THUMB_WIDTH = 132;

interface OutlineRailProps {
  doc: OfdDocument;
}

export function OutlineRail({ doc }: OutlineRailProps) {
  const page = useViewerState().page;
  const railRef = useRef<HTMLDivElement | null>(null);

  // Keep the active thumbnail in view when paging with the keyboard or toolbar.
  useEffect(() => {
    const container = railRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(`[data-thumb="${page}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [page]);

  return (
    <aside className="outline" ref={railRef} aria-label="页面缩略图">
      {doc.pages.map((meta) => (
        <Thumbnail
          key={meta.index}
          doc={doc}
          index={meta.index}
          active={meta.index === page}
          widthMm={meta.width}
          heightMm={meta.height}
          scanned={meta.scanned}
        />
      ))}
    </aside>
  );
}

interface ThumbnailProps {
  doc: OfdDocument;
  index: number;
  active: boolean;
  widthMm: number;
  heightMm: number;
  scanned: boolean;
}

const Thumbnail = memo(function Thumbnail({
  doc,
  index,
  active,
  widthMm,
  heightMm,
  scanned,
}: ThumbnailProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = useIsVisible(ref, { rootMargin: '800px 0px' });
  const pxPerMm = THUMB_WIDTH / widthMm;

  return (
    <div
      ref={ref}
      data-thumb={index}
      className={`thumb${active ? ' active' : ''}`}
      onClick={() => viewerActions.goToPage(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') viewerActions.goToPage(index);
      }}
    >
      <div
        className="thumb-canvas"
        style={{ width: `${THUMB_WIDTH}px`, height: `${Math.max(24, Math.round(heightMm * pxPerMm))}px` }}
      >
        {visible ? (
          <PageCanvas
            doc={doc}
            index={index}
            widthMm={widthMm}
            heightMm={heightMm}
            rotation={0}
            pxPerMm={pxPerMm}
            decorative
          />
        ) : (
          <div className="thumb-placeholder" />
        )}
      </div>
      <div className="thumb-footer">
        <span>{index + 1}</span>
        {scanned ? <span className="badge">扫描</span> : null}
      </div>
    </div>
  );
});
