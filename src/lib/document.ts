/**
 * Document loader: reads an OFD container into a viewer-ready model.
 *
 * - Container metadata comes from `loadOfdContainer` (ZIP → OFD.xml → Document.xml →
 *   DocumentRes.xml → PublicRes.xml).
 * - Embedded images are extracted as object URLs; originals stay compressed until painted.
 * - Page content is parsed lazily and cached, so a 1000-page scan opens instantly.
 */

import { loadOfdContainer, resolveArchivePath, type OfdContainer } from './container';
import { ImageStore } from './image-store';
import { buildFontMap, loadImageAssets } from './resources';
import { parsePageElement, parseXmlElement, type TemplatePages } from './page-parser';
import type { ParsedPage } from '../render/types';
import type { LoadProgress, OfdDocument, PageMeta } from './types';

/** Pages whose XML is analysed eagerly so sizes and scan detection are exact up front. */
const EAGER_PAGE_METADATA = 24;
const PAGE_CACHE_LIMIT = 48;

function parseSize(
  box: string,
  fallback = { width: 210, height: 297 },
): { width: number; height: number } {
  const parts = box.trim().split(/\s+/).map(Number);
  if (
    parts.length >= 4 &&
    Number.isFinite(parts[2]) &&
    Number.isFinite(parts[3]) &&
    parts[2] > 0 &&
    parts[3] > 0
  ) {
    return { width: parts[2], height: parts[3] };
  }
  return fallback;
}

export interface LoadOptions {
  onProgress?: (progress: LoadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Load an OFD file into a viewer-ready document.
 *
 * Accepts a `File` (from a picker or drop), a `Blob`, or a raw `ArrayBuffer` — the latter
 * is what the Node harness and `fetch(...).arrayBuffer()` callers pass.
 */
export async function loadOfdDocument(
  source: File | Blob | ArrayBuffer,
  options: LoadOptions = {},
): Promise<OfdDocument> {
  const { onProgress, signal } = options;
  const file =
    source instanceof File
      ? source
      : source instanceof Blob
        ? new File([source], 'document.ofd')
        : new File([source], 'document.ofd');
  const name = file.name || 'document.ofd';

  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  };

  onProgress?.({ phase: 'reading', message: '读取文件…', ratio: 0.02 });
  const container = await loadOfdContainer(source, {
    onProgress: (message, ratio) => onProgress?.({ phase: 'parsing', message, ratio }),
  });
  checkAborted();

  if (container.pages.length === 0) throw new Error('该文档没有任何页面。');
  const defaultSize = parseSize(container.pageAreaBox);

  const fonts = buildFontMap(container);

  // ------------------------------------------------------------------ templates
  const templates = new Map<string, Element>();
  for (const template of container.templatePages) {
    checkAborted();
    try {
      const xml = await container.readText(resolveArchivePath(container.docRoot, template.baseLoc));
      templates.set(template.id, parseXmlElement(xml));
    } catch (error) {
      console.warn(`[ofd] 模板 ${template.id} (${template.baseLoc}) 读取失败`, error);
    }
  }
  const templatePages: TemplatePages = { get: (id) => templates.get(id) ?? null };

  // ------------------------------------------------------------------ images
  onProgress?.({ phase: 'resources', message: '提取图片资源…', ratio: 0.25 });
  const assets = await loadImageAssets(container, (loaded, total) => {
    onProgress?.({
      phase: 'resources',
      message: `提取图片资源… (${loaded}/${total})`,
      ratio: total > 0 ? 0.25 + 0.55 * (loaded / total) : 0.6,
    });
  });
  checkAborted();
  const images = new ImageStore(assets);

  // ------------------------------------------------------------------ page parsing
  const parsePage = async (index: number): Promise<ParsedPage> => {
    const entry = container.pages[index];
    if (!entry) throw new Error(`页面索引越界: ${index}`);
    const xml = await container.readText(resolveArchivePath(container.docRoot, entry.baseLoc));
    return parsePageElement(index, parseXmlElement(xml), fonts, {
      fallbackSize: defaultSize,
      templates: templatePages,
    });
  };

  const metas: PageMeta[] = [];
  const estimate = (index: number): PageMeta => ({
    index,
    id: container.pages[index].id,
    width: defaultSize.width,
    height: defaultSize.height,
    scanned: false,
    estimated: true,
  });

  const eagerCount = Math.min(container.pages.length, EAGER_PAGE_METADATA);
  for (let index = 0; index < eagerCount; index += 1) {
    checkAborted();
    try {
      const parsed = await parsePage(index);
      metas[index] = {
        index,
        id: container.pages[index].id,
        width: parsed.width,
        height: parsed.height,
        scanned: parsed.scan !== null,
        estimated: false,
      };
    } catch (error) {
      console.warn(`[ofd] 第 ${index + 1} 页预解析失败`, error);
      metas[index] = estimate(index);
    }
  }
  for (let index = eagerCount; index < container.pages.length; index += 1) {
    metas[index] = estimate(index);
  }

  // ------------------------------------------------------------------ assembly
  // Map preserves insertion order, so the first key is the least recently inserted page.
  const cache = new Map<number, ParsedPage>();
  let disposed = false;

  const loadPage = async (index: number): Promise<ParsedPage> => {
    const cached = cache.get(index);
    if (cached) return cached;
    if (disposed) throw new Error('文档已关闭');

    const parsed = await parsePage(index);
    cache.set(index, parsed);
    metas[index] = {
      index,
      id: container.pages[index].id,
      width: parsed.width,
      height: parsed.height,
      scanned: parsed.scan !== null,
      estimated: false,
    };
    if (cache.size > PAGE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return parsed;
  };

  onProgress?.({ phase: 'ready', message: '就绪', ratio: 1 });

  return {
    name,
    byteLength: file.size,
    pageCount: container.pages.length,
    pages: metas,
    images,
    fonts,
    defaultWidth: defaultSize.width,
    defaultHeight: defaultSize.height,
    loadPage,
    peekPage: (index: number) => cache.get(index),
    dispose: () => {
      disposed = true;
      cache.clear();
      templates.clear();
      images.dispose();
    },
  };
}

export type { OfdContainer };
