/**
 * Debug/inspection harness for the parsing + rendering pipeline.
 *
 * Runs the real viewer modules (via Vite's `ssrLoadModule`) against the reference OFD files
 * with lightweight DOM stubs, then prints the page IR and every canvas draw call. This is
 * how the renderer is verified without a browser: no PNG encoding, just an operation log.
 *
 * Usage:
 *   node scripts/inspect-render.mjs <file.ofd> [pageIndex] [dpi]
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'vite';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const pageIndex = Number(process.argv[3] ?? 0);
const dpi = Number(process.argv[4] ?? 96);
if (!file) {
  console.error('usage: node scripts/inspect-render.mjs <file.ofd> [pageIndex] [dpi]');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * DOM stubs
 * ------------------------------------------------------------------ */

const { document, window, Document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;
globalThis.window = window;
globalThis.DOMParser = window.DOMParser;
globalThis.Document = Document;

class StubContext {
  constructor() {
    this.ops = [];
    this.saves = 0;
  }
  #push(name, args) {
    this.ops.push(`${name}(${args.map((a) => (typeof a === 'number' ? a.toFixed(3) : String(a))).join(', ')})`);
  }
  save() { this.saves += 1; this.#push('save', []); }
  restore() { this.#push('restore', []); }
  transform(...a) { this.#push('transform', a); }
  scale(...a) { this.#push('scale', a); }
  translate(...a) { this.#push('translate', a); }
  rotate(...a) { this.#push('rotate', a); }
  setTransform(...a) { this.#push('setTransform', a); }
  clearRect(...a) { this.#push('clearRect', a); }
  beginPath() { this.#push('beginPath', []); }
  closePath() { this.#push('closePath', []); }
  moveTo(...a) { this.#push('moveTo', a); }
  lineTo(...a) { this.#push('lineTo', a); }
  bezierCurveTo(...a) { this.#push('bezierCurveTo', a); }
  quadraticCurveTo(...a) { this.#push('quadraticCurveTo', a); }
  fill(...a) { this.#push('fill', a); }
  stroke(...a) { this.#push('stroke', a); }
  setLineDash(a) { this.#push('setLineDash', [JSON.stringify(a)]); }
  fillText(...a) { this.#push('fillText', a); }
  strokeText(...a) { this.#push('strokeText', a); }
  measureText(text) {
    // Approximate a real font metric so the spacing guard can be exercised in Node.
    return { width: String(text).length * 0.5 * this.__fontSize };
  }
  drawImage(bitmap, ...a) {
    this.#push('drawImage', [`<${bitmap?.constructor?.name ?? typeof bitmap} ${bitmap?.width ?? '?'}x${bitmap?.height ?? '?'}>`, ...a]);
  }
}
Object.defineProperty(StubContext.prototype, 'fillStyle', { set() {}, get() { return '#000'; } });
Object.defineProperty(StubContext.prototype, 'strokeStyle', { set() {}, get() { return '#000'; } });
Object.defineProperty(StubContext.prototype, 'lineWidth', { set() {}, get() { return 1; } });
Object.defineProperty(StubContext.prototype, 'lineCap', { set() {}, get() { return 'butt'; } });
Object.defineProperty(StubContext.prototype, 'lineJoin', { set() {}, get() { return 'miter'; } });
Object.defineProperty(StubContext.prototype, 'font', {
  set(value) {
    const match = /(\d+(?:\.\d+)?)px/.exec(String(value));
    this.__fontSize = match ? Number(match[1]) : 8;
  },
  get() {
    return `${this.__fontSize ?? 8}px stub`;
  },
});

const lastContexts = [];

function makeStubCanvas() {
  const context = new StubContext();
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => {
      lastContexts.push(context);
      return context;
    },
    toBlob: (callback) => callback(null),
    __context: context,
  };
}
globalThis.__makeStubCanvas = makeStubCanvas;

// Blob that carries raw bytes so the harness can sniff dimensions synchronously.
class StubBlob {
  constructor(parts = [], options = {}) {
    const chunks = parts.map((part) => {
      if (part instanceof ArrayBuffer) return new Uint8Array(part);
      if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      if (typeof part === 'string') return new TextEncoder().encode(part);
      return new Uint8Array(0);
    });
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    // A standalone ArrayBuffer keeps JSZip happy (it validates byte offsets strictly).
    this.buffer = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
    this.bytes = new Uint8Array(this.buffer);
    this.size = size;
    this.type = options.type ?? '';
  }
  slice() {
    return this;
  }
}
globalThis.Blob = StubBlob;

// Image stub: reports dimensions parsed from the PNG header once "decoded".
globalThis.Image = class StubImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.width = 0;
    this.height = 0;
  }
  set src(value) {
    this._src = value;
  }
  get src() {
    return this._src ?? '';
  }
  async decode() {
    const blob = this._src?.__blob;
    if (!blob) throw new Error('stub image has no blob');
    const dims = imageSize(blob.bytes);
    if (!dims) throw new Error('stub image could not read the image header');
    this.width = this.naturalWidth = dims.width;
    this.height = this.naturalHeight = dims.height;
    this.constructor = Image;
  }
};
Object.defineProperty(globalThis.Image, 'name', { value: 'Image' });

/** ImageBitmap-like stand-in carrying dimensions for createImageBitmap. */
class StubImageBitmap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  close() {}
}
globalThis.ImageBitmap = StubImageBitmap;
globalThis.createImageBitmap = async (blob) => {
  const dims = imageSize(blob.bytes);
  if (!dims) throw new Error('createImageBitmap: unsupported stub image format');
  return new StubImageBitmap(dims.width, dims.height);
};

// Object URLs: keep the blob reachable from the stub <img>.
let urlCounter = 0;
const urlBlobs = new Map();
globalThis.URL.createObjectURL = (blob) => {
  urlCounter += 1;
  const url = `blob:stub/${urlCounter}`;
  urlBlobs.set(url, blob);
  if (blob && typeof blob === 'object') blob.__url = url;
  return url;
};
globalThis.URL.revokeObjectURL = () => {};

/** Minimal JPEG SOF reader: walks the marker segments to find the frame header. */
function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Image dimensions from the container signature (PNG or JPEG). */
function imageSize(bytes) {
  return pngSize(bytes) ?? jpegSize(bytes);
}

/** Minimal PNG IHDR reader. */
function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/* ------------------------------------------------------------------ *
 * Run the pipeline
 * ------------------------------------------------------------------ */

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

try {
  const documentModule = await server.ssrLoadModule('/src/lib/document.ts');
  const rendererModule = await server.ssrLoadModule('/src/render/renderer.ts');

  const buffer = fs.readFileSync(file);
  // JSZip sniffs Node and no longer accepts Blob there, so hand it an ArrayBuffer and
  // let loadOfdDocument wrap it in a File (the browser path does exactly the same).
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  console.log(`loading ${path.basename(file)} (${buffer.length} bytes)`);
  const doc = await documentModule.loadOfdDocument(bytes, {
    onProgress: (progress) => process.stdout.write(`  [progress] ${progress.phase} ${progress.message}\n`),
  });

  console.log(`pages: ${doc.pageCount}, images: ${doc.images.size}, fonts: ${doc.fonts.size}`);
  console.log('page metadata:', doc.pages.map((m) => `${m.index + 1}:${m.width.toFixed(1)}x${m.height.toFixed(1)}${m.scanned ? '[scan]' : ''}${m.estimated ? '[est]' : ''}`).join(' '));

  const page = await doc.loadPage(pageIndex);
  console.log(`\n--- page ${pageIndex + 1}: ${page.width.toFixed(2)} x ${page.height.toFixed(2)} mm, scan=${page.scan ? page.scan.resourceId : 'no'}`);
  for (const item of page.items) {
    if (item.kind === 'image') {
      console.log(`  image res=${item.resourceId} box=${JSON.stringify(item.box)} ctm=${item.ctm.map((n) => n.toFixed(3)).join(' ')}`);
    } else if (item.kind === 'text') {
      console.log(`  text "${item.text.slice(0, 40)}" size=${item.size} font=${item.fontFamily} box=${JSON.stringify(item.box)} deltaX=${item.deltaX?.length ?? 0}`);
    } else if (item.kind === 'path') {
      console.log(`  path cmds=${item.commands.length} fill=${item.fill ? 'yes' : 'no'} stroke=${item.stroke ? 'yes' : 'no'} lw=${item.lineWidth}`);
    } else {
      console.log(`  group children=${item.children.length}`);
    }
  }

  // SVG dump for eyeballing geometry.
  if (process.env.SVG_OUT) {
    const svg = toSvg(page);
    fs.writeFileSync(process.env.SVG_OUT, svg);
    console.log(`svg written: ${process.env.SVG_OUT}`);
  }

  // Render with the real renderer. The first pass requests decodes; the second pass has
  // the bitmaps available and is what the browser ends up showing.
  const pxPerMm = dpi / 25.4;
  const first = makeStubCanvas();
  const result = rendererModule.renderPageToCanvas(first, page, { pxPerMm, images: doc.images });
  console.log(`\nrender pass 1: ${result.width}x${result.height}px @ ${dpi}dpi, pending=[${result.pending.join(',')}] clamped=${result.clamped}`);

  // Let the pending decodes settle.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const second = makeStubCanvas();
  const result2 = rendererModule.renderPageToCanvas(second, page, { pxPerMm, images: doc.images });
  console.log(`render pass 2: ${result2.width}x${result2.height}px, pending=[${result2.pending.join(',')}]`);
  const ops = second.__context.ops;
  console.log(`draw ops: ${ops.length}`);
  for (const op of ops) console.log('  ' + op);

  doc.dispose();
} finally {
  await server.close();
}

/** Serialise the page IR to SVG for visual comparison. */
function toSvg(page) {
  const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = [];
  for (const item of page.items) {
    if (item.kind === 'image') {
      body.push(`<image href="images/${item.resourceId}.jpg" x="${item.box.x}" y="${item.box.y}" width="${item.box.width}" height="${item.box.height}" transform="matrix(${item.ctm.join(' ')})" />`);
    } else if (item.kind === 'path') {
      const d = item.commands
        .map((command) => {
          if (command.type === 'Z') return 'Z';
          if (command.type === 'C') return `C ${command.x1} ${command.y1} ${command.x2} ${command.y2} ${command.x} ${command.y}`;
          if (command.type === 'Q') return `Q ${command.x1} ${command.y1} ${command.x} ${command.y}`;
          return `${command.type} ${command.x} ${command.y}`;
        })
        .join(' ');
      const fill = item.fill ? `rgba(${item.fill.r},${item.fill.g},${item.fill.b},${item.fill.alpha})` : 'none';
      const stroke = item.stroke ? `rgba(${item.stroke.r},${item.stroke.g},${item.stroke.b},${item.stroke.alpha})` : 'none';
      body.push(`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${item.lineWidth}" transform="matrix(${item.ctm.join(' ')})" />`);
    } else if (item.kind === 'text') {
      const fill = item.fill ? `rgba(${item.fill.r},${item.fill.g},${item.fill.b},${item.fill.alpha})` : '#000';
      body.push(`<text x="${item.box.x + item.offsetX}" y="${item.box.y + item.offsetY}" font-size="${item.size}" font-family="${esc(item.fontFamily)}" fill="${fill}">${esc(item.text)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}">${body.join('')}</svg>`;
}
