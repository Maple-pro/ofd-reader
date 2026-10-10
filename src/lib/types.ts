/**
 * Viewer-facing document model.
 */

import type { ParsedPage } from '../render/types';
import type { ImageStore } from './image-store';
import type { FontEntry } from './resources';

export interface PageMeta {
  index: number;
  id: string;
  /** Page size in mm (before rotation). */
  width: number;
  height: number;
  /** True when the page is drawn as a single full-page raster image (a scan). */
  scanned: boolean;
  /** Size is still a document-level estimate (the page's own Area has not been read). */
  estimated: boolean;
}

export interface OfdDocument {
  name: string;
  byteLength: number;
  /** Number of pages. */
  pageCount: number;
  pages: PageMeta[];
  images: ImageStore;
  fonts: Map<string, FontEntry>;
  /** Document-level fallback page size (mm). */
  defaultWidth: number;
  defaultHeight: number;
  /** Parse a page on demand; results are cached (LRU). */
  loadPage(index: number): Promise<ParsedPage>;
  /** Peek at a cached page without parsing. */
  peekPage(index: number): ParsedPage | undefined;
  /** Release object URLs and decoded bitmaps. */
  dispose(): void;
}

export interface LoadProgress {
  phase: 'reading' | 'parsing' | 'resources' | 'ready';
  message: string;
  /** 0..1 when known. */
  ratio?: number;
}
