/**
 * Image store: object URLs (for the scanned-page fast path) plus lazily decoded bitmaps
 * (for canvas rendering).
 *
 * Scanned OFD files embed one 200–400 DPI JPEG per page. Decoding all of them up front
 * costs hundreds of megabytes, so bitmaps are decoded on demand: the renderer asks for a
 * resource, gets `null` the first time (which triggers decoding) and repaints when the
 * pending promise resolves.
 */

import type { ImageAsset } from './resources';

export class ImageStore {
  private readonly assets: Map<string, ImageAsset>;
  private readonly bitmaps = new Map<string, CanvasImageSource>();
  private readonly decodes = new Map<string, Promise<CanvasImageSource | null>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(assets: Map<string, ImageAsset>) {
    this.assets = assets;
  }

  get size(): number {
    return this.assets.size;
  }

  asset(resourceId: string): ImageAsset | undefined {
    return this.assets.get(resourceId);
  }

  /** Decoded bitmap, or null while it is still being decoded. */
  get(resourceId: string): CanvasImageSource | null {
    if (this.disposed) return null;
    const ready = this.bitmaps.get(resourceId);
    if (ready) return ready;

    const asset = this.assets.get(resourceId);
    if (!asset) return null;

    // Decode at most once per resource; the promise map doubles as a "already tried" set.
    if (!this.decodes.has(resourceId)) {
      const promise = this.decode(resourceId, asset);
      this.decodes.set(resourceId, promise);
      void promise.then(() => {
        this.notify();
      });
    }
    return null;
  }

  private async decode(
    resourceId: string,
    asset: ImageAsset,
  ): Promise<CanvasImageSource | null> {
    try {
      const bitmap = await createImageBitmap(asset.blob);
      if (this.disposed) {
        bitmap.close();
        return null;
      }
      asset.naturalWidth = bitmap.width;
      asset.naturalHeight = bitmap.height;
      this.bitmaps.set(resourceId, bitmap);
      return bitmap;
    } catch (error) {
      // Fall back to an <img> element — decode() of an <img> also gives dimensions.
      try {
        const image = new Image();
        image.src = asset.url;
        await image.decode();
        if (this.disposed) return null;
        asset.naturalWidth = image.naturalWidth;
        asset.naturalHeight = image.naturalHeight;
        this.bitmaps.set(resourceId, image);
        return image;
      } catch (fallbackError) {
        console.warn(`[ofd] could not decode image ${resourceId}`, error, fallbackError);
        return null;
      }
    }
  }

  /** Subscribe to "a bitmap became available" notifications. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.disposed = true;
    for (const bitmap of this.bitmaps.values()) {
      if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close();
    }
    this.bitmaps.clear();
    this.decodes.clear();
    for (const asset of this.assets.values()) {
      URL.revokeObjectURL(asset.url);
    }
    this.assets.clear();
    this.listeners.clear();
  }
}
