/**
 * Small viewer store built on `useSyncExternalStore`.
 *
 * Keeping viewer state in a store (rather than lifting it into App) means the built-in
 * toolbar, the keyboard shortcuts and any host-provided UI all drive the same state, and
 * each component re-renders only for the fields it selects.
 */

import { useSyncExternalStore } from 'react';
import type { OfdDocument } from '../lib/types';
import type { ZoomMode } from '../hooks/useViewTransform';

export interface ViewerState {
  doc: OfdDocument | null;
  page: number;
  zoomMode: ZoomMode;
  /** Scale used when zoomMode === 'custom' (CSS px per mm). */
  customScale: number;
  rotation: number;
  outlineOpen: boolean;
  /** Current rendered scale (px/mm) so the toolbar can show a percentage. */
  effectiveScale: number;
  fitWidthScale: number;
  fitPageScale: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let versionCounter = 0;

let state: ViewerState = {
  doc: null,
  page: 0,
  zoomMode: 'fit-width',
  customScale: 1,
  rotation: 0,
  outlineOpen: true,
  effectiveScale: 1,
  fitWidthScale: 1,
  fitPageScale: 1,
};

function emit(): void {
  versionCounter += 1;
  for (const listener of listeners) listener();
}

function setState(patch: Partial<ViewerState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof ViewerState>) {
    if (state[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}


/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export const viewerActions = {
  reset(): void {
    setState({
      page: 0,
      zoomMode: 'fit-width',
      customScale: 1,
      rotation: 0,
      effectiveScale: 1,
      fitWidthScale: 1,
      fitPageScale: 1,
    });
  },

  setDocument(doc: OfdDocument | null): void {
    setState({ doc, page: 0 });
  },

  goToPage(page: number): void {
    const total = state.doc?.pageCount ?? 0;
    if (total === 0) {
      setState({ page: 0 });
      return;
    }
    setState({ page: Math.max(0, Math.min(total - 1, page)) });
  },

  nextPage(): void {
    viewerActions.goToPage(state.page + 1);
  },

  previousPage(): void {
    viewerActions.goToPage(state.page - 1);
  },

  setZoomMode(mode: ZoomMode, scale?: number): void {
    setState({
      zoomMode: mode,
      customScale: scale !== undefined ? scale : state.customScale,
    });
  },

  setZoomScale(scale: number): void {
    setState({ zoomMode: 'custom', customScale: scale });
  },

  rotate(delta: number): void {
    setState({ rotation: (((state.rotation + delta) % 360) + 360) % 360 });
  },

  toggleOutline(): void {
    setState({ outlineOpen: !state.outlineOpen });
  },

  setOutline(open: boolean): void {
    setState({ outlineOpen: open });
  },

  reportGeometry(effectiveScale: number, fitWidthScale: number, fitPageScale: number): void {
    setState({ effectiveScale, fitWidthScale, fitPageScale });
  },
};

/* ------------------------------------------------------------------ *
 * React bindings
 * ------------------------------------------------------------------ */

/**
 * Subscribe React to the store.
 *
 * A monotonically increasing version is the snapshot: it is always a primitive, so the
 * store can never trigger an infinite render loop the way an unstable object snapshot
 * would. Selector results are computed by the caller from the returned state.
 */
export function useViewerState(): ViewerState {
  const version = useSyncExternalStore(subscribe, () => versionCounter, () => versionCounter);
  void version;
  return state;
}

export function useViewerActions() {
  return viewerActions;
}

/** Imperative access for non-React callers (e.g. host page wiring). */
export function getViewerState(): ViewerState {
  return state;
}

export function subscribeViewer(listener: Listener): () => void {
  return subscribe(listener);
}
