/**
 * Resource resolution: fonts from PublicRes.xml and images from DocumentRes.xml.
 *
 * Images are kept as object URLs over the original (still compressed) bytes. Decoding to
 * bitmaps is deliberately deferred to `ImageStore`, because a scanned OFD can hold
 * hundreds of 200–400 DPI JPEGs.
 */

import type { OfdContainer } from './container';
import { resolveArchivePath } from './container';

export interface FontEntry {
  family: string;
  bold: boolean;
  italic: boolean;
}

export interface ImageAsset {
  resourceId: string;
  /** Object URL of the original bytes. */
  url: string;
  blob: Blob;
  mime: string;
  name: string;
  byteLength: number;
  /** Natural pixel size; 0 until the browser has decoded the image. */
  naturalWidth: number;
  naturalHeight: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jb2: 'image/jbig2',
  jbig2: 'image/jbig2',
  svg: 'image/svg+xml',
};

const MIME_BY_FORMAT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  jbig2: 'image/jbig2',
  jb2: 'image/jbig2',
  svg: 'image/svg+xml',
};

export function imageMimeType(format: unknown, fileName: string): string {
  const fmt = typeof format === 'string' ? format.trim().toLowerCase() : '';
  if (fmt && MIME_BY_FORMAT[fmt]) return MIME_BY_FORMAT[fmt];
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? '';
}

/** Formats the browser can decode in an <img> / drawImage without extra work. */
export function isBrowserDecodable(mime: string): boolean {
  return (
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/gif' ||
    mime === 'image/webp' ||
    mime === 'image/bmp' ||
    mime === 'image/svg+xml'
  );
}

function sanitizeFontFamily(name: string): string {
  const trimmed = name.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return '';
  // Font names can carry quotes, semicolons or CIDs — keep plain family names.
  return trimmed.replace(/["'\\;{}()]/g, '');
}

/**
 * Build a font table keyed by resource ID.
 *
 * OFD keeps the family name in `FamilyName`; `FontName` is often a PostScript or CID name
 * that browsers cannot match, so it is only a fallback.
 */
export function buildFontMap(container: OfdContainer): Map<string, FontEntry> {
  const fonts = new Map<string, FontEntry>();
  for (const font of container.fonts) {
    const family =
      sanitizeFontFamily(font.familyName) ||
      sanitizeFontFamily(font.fontName) ||
      '';
    fonts.set(font.id, {
      family: family || 'sans-serif',
      bold: font.bold,
      italic: font.italic,
    });
  }
  return fonts;
}

/**
 * Extract every embedded image into an object URL.
 *
 * @param onProgress called as `(loaded, total)` while extracting.
 */
export async function loadImageAssets(
  container: OfdContainer,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Map<string, ImageAsset>> {
  const assets = new Map<string, ImageAsset>();
  const total = container.medias.length;
  let loaded = 0;

  for (const media of container.medias) {
    loaded += 1;
    onProgress?.(loaded, total);

    const name = media.mediaFile;
    if (!name) continue;

    const mime = imageMimeType(media.format, name);
    if (!isBrowserDecodable(mime)) {
      console.warn(
        `[ofd] 暂不支持该图片格式 "${media.format || name.split('.').pop()}"（${name}），已跳过`,
      );
      continue;
    }

    const path = container.mediaBaseLoc
      ? resolveArchivePath(container.documentResPath, `${container.mediaBaseLoc}/${name}`)
      : resolveArchivePath(container.documentResPath, name);

    try {
      const buffer = await container.readBinary(path);
      const blob = new Blob([buffer], { type: mime });
      assets.set(media.id, {
        resourceId: media.id,
        url: URL.createObjectURL(blob),
        blob,
        mime,
        name,
        byteLength: blob.size,
        naturalWidth: 0,
        naturalHeight: 0,
      });
    } catch (error) {
      console.warn(`[ofd] 提取图片资源失败 ${name}`, error);
    }
  }

  return assets;
}

/** Resolve the archive path of a page or template content file. */
export function pageContentPath(container: OfdContainer, baseLoc: string): string {
  return resolveArchivePath(container.docRoot, baseLoc);
}
