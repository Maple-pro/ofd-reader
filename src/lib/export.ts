import type { OfdDocument } from '../lib/types';
import { canvasSizeFor, renderPageToCanvas } from '../render/renderer';

export interface ExportOptions {
  /** Output density. 96 dpi matches typical screen viewing; 200–300 for print. */
  dpi?: number;
}

/**
 * Render a page to an offscreen canvas at a given DPI.
 *
 * The document keeps decoded bitmaps for the pages it has already shown, so exporting the
 * current page is usually instant.
 */
export async function renderPageToBlob(
  doc: OfdDocument,
  index: number,
  options: ExportOptions = {},
): Promise<Blob> {
  const page = await doc.loadPage(index);
  const dpi = options.dpi ?? 150;
  const pxPerMm = dpi / 25.4;
  const size = canvasSizeFor(page.width, page.height, pxPerMm);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  renderPageToCanvas(canvas, page, { pxPerMm, images: doc.images });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('导出图片失败');
  return blob;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Export one page as a JPEG download. */
export async function downloadPage(
  doc: OfdDocument,
  index: number,
  options: ExportOptions = {},
): Promise<void> {
  const blob = await renderPageToBlob(doc, index, options);
  const base = doc.name.replace(/\.ofd$/i, '') || 'document';
  triggerDownload(blob, `${base}-第${index + 1}页.jpg`);
}

/**
 * Print a page (or the whole document) by rendering to JPEGs and printing them from a
 * hidden iframe — avoids the browser having to understand OFD and keeps output crisp.
 */
export async function printPages(
  doc: OfdDocument,
  indexes: number[],
  options: ExportOptions = { dpi: 200 },
): Promise<void> {
  const urls: string[] = [];
  for (const index of indexes) {
    const blob = await renderPageToBlob(doc, index, options);
    urls.push(URL.createObjectURL(blob));
  }

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  document.body.append(iframe);

  const frameWindow = iframe.contentWindow;
  const frameDocument = iframe.contentDocument;
  if (!frameWindow || !frameDocument) {
    iframe.remove();
    throw new Error('无法创建打印视图');
  }

  frameDocument.open();
  frameDocument.write(`<!doctype html><html><head><title>${doc.name}</title>
    <style>
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      img { display: block; width: 100%; page-break-after: always; break-after: page; }
      img:last-child { page-break-after: auto; break-after: auto; }
    </style></head><body>
      ${urls.map((url) => `<img src="${url}" />`).join('')}
    </body></html>`);
  frameDocument.close();

  const cleanup = () => {
    setTimeout(() => {
      for (const url of urls) URL.revokeObjectURL(url);
      iframe.remove();
    }, 1000);
  };

  // Wait for the images to be decoded so the print dialog sees complete pages.
  const images = Array.from(frameDocument.images);
  await Promise.all(
    images.map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
    ),
  );

  frameWindow.focus();
  frameWindow.print();
  frameWindow.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 60000);
}
