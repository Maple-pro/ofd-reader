/**
 * OFD container reader.
 *
 * An OFD file is a ZIP archive laid out as:
 *
 *   OFD.xml              → DocBody / DocRoot
 *   <DocRoot>            → CommonData (PageArea, DocumentRes, PublicRes, TemplatePages) + Pages
 *   <DocumentRes.xml>    → MultiMedia entries (embedded images)
 *   <PublicRes.xml>      → Font entries
 *   <Pages/…/Content.xml>→ one file per page
 *
 * The parsing model mirrors @sharp9/ofdjs (an Apache-2.0 JS OFD reader): the same element
 * and attribute names, resolved through the same relative-path rules. It is inlined here
 * because that package's optional Node dependencies (`canvas`, `linkedom`,
 * `@xmldom/xmldom`) are statically imported by its entry point, which breaks browser
 * bundling — and because this app needs `AbbreviatedData`, which that reader drops.
 *
 * All paths inside the archive are POSIX-style and relative to the ZIP root.
 */

import JSZip from 'jszip';

export interface OfdPageEntry {
  id: string;
  baseLoc: string;
}

export interface OfdTemplatePageEntry {
  id: string;
  baseLoc: string;
}

export interface OfdMediaEntry {
  id: string;
  format: string;
  mediaFile: string;
}

export interface OfdFontEntry {
  id: string;
  familyName: string;
  fontName: string;
  bold: boolean;
  italic: boolean;
}

export interface OfdContainer {
  docType: string;
  version: string;
  docRoot: string;
  pageAreaBox: string;
  documentResPath: string;
  publicResPath: string;
  pages: OfdPageEntry[];
  templatePages: OfdTemplatePageEntry[];
  medias: OfdMediaEntry[];
  fonts: OfdFontEntry[];
  mediaBaseLoc: string;
  fontBaseLoc: string;
  /** Read a text file from the archive. */
  readText(path: string): Promise<string>;
  /** Read a binary file from the archive. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Paths present in the archive (for diagnostics). */
  entries(): string[];
}

/* ------------------------------------------------------------------ *
 * XML helpers (namespace agnostic — producers use OFD, ofd and no prefix)
 * ------------------------------------------------------------------ */

/**
 * Local element name without any namespace prefix.
 *
 * Not every DOM implementation strips the prefix from `localName` for XML documents
 * (linkedom keeps it), so the prefix is removed explicitly.
 */
function tagOf(node: Element): string {
  const name = node.localName || node.nodeName || '';
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function parseXml(text: string, label: string): Document {
  // Strip a UTF-8/UTF-16 BOM; some producers write one.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const doc = new DOMParser().parseFromString(clean, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    const detail = doc.getElementsByTagName('parsererror')[0]?.textContent?.trim() ?? '';
    throw new Error(`${label} 不是有效的 XML${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  return doc;
}

/**
 * Namespace-agnostic walker.
 *
 * `getElementsByTagNameNS('*', name)` is unreliable across DOM implementations (linkedom
 * and xmldom both differ from the browser), so descendants are matched on local name.
 * The OFD schemas are small, so a manual walk costs nothing.
 */
function descendants(root: Element, name: string): Element[] {
  const found: Element[] = [];
  const visit = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (tagOf(child) === name) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function firstDescendant(root: Element | Document, name: string): Element | null {
  const scope = root instanceof Document ? root.documentElement : (root as Element);
  if (!scope) return null;
  if (tagOf(scope) === name) return scope;
  return descendants(scope, name)[0] ?? null;
}

/** All descendants matching `name`, treating the root itself as a candidate. */
function findAll(root: Element | Document, name: string): Element[] {
  const scope = root instanceof Document ? root.documentElement : (root as Element);
  if (!scope) return [];
  const found = descendants(scope, name);
  if (tagOf(scope) === name) found.unshift(scope);
  return found;
}

function text(parent: Element | Document, name: string): string {
  return firstDescendant(parent, name)?.textContent?.trim() ?? '';
}

function attr(el: Element | null, name: string): string {
  return el?.getAttribute(name) ?? '';
}

/* ------------------------------------------------------------------ *
 * Path resolution
 * ------------------------------------------------------------------ */

/** POSIX join with `..`/`.` resolution; archive paths never start with `/`. */
export function resolveArchivePath(baseFile: string, relative: string): string {
  const clean = (value: string) => (value.startsWith('/') ? value.slice(1) : value);
  const base = clean(baseFile);
  const rel = clean(relative);
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  const combined = rel.startsWith('/') ? rel.slice(1) : dir ? `${dir}/${rel}` : rel;
  return normalisePath(combined);
}

export function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export interface LoadContainerOptions {
  onProgress?: (message: string, ratio: number) => void;
}

/** Unzip an OFD file and parse its container metadata. */
export async function loadOfdContainer(
  data: ArrayBuffer | Blob | File,
  options: LoadContainerOptions = {},
): Promise<OfdContainer> {
  const { onProgress } = options;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`文件不是有效的 ZIP/OFD 压缩包（${detail}）。`);
  }

  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const findEntry = (wanted: string): string | undefined => {
    const exact = names.find((name) => name === wanted);
    if (exact) return exact;
    const lower = wanted.toLowerCase();
    return names.find((name) => name.toLowerCase() === lower);
  };

  const readEntry = async (path: string): Promise<string> => {
    const resolved = findEntry(path);
    if (!resolved) throw new Error(`压缩包内缺少文件: ${path}`);
    return zip.files[resolved].async('string');
  };

  const ofdXmlName = findEntry('OFD.xml');
  if (!ofdXmlName) {
    throw new Error('缺少 OFD.xml，这可能不是 OFD 文件（OFD 是包含 OFD.xml 的压缩包）。');
  }

  onProgress?.('解析 OFD.xml…', 0.05);
  const ofdDoc = parseXml(await readEntry(ofdXmlName), 'OFD.xml');
  const root = ofdDoc.documentElement;
  const docRoot = text(ofdDoc, 'DocRoot');
  if (!docRoot) throw new Error('OFD.xml 中缺少 DocRoot。');

  const docXmlName = findEntry(docRoot);
  if (!docXmlName) throw new Error(`找不到文档主入口 ${docRoot}。`);

  onProgress?.('解析文档结构…', 0.12);
  const documentDoc = parseXml(await readEntry(docXmlName), docRoot);

  /**
   * Collect `ID`/`BaseLoc` entries for a list element.
   *
   * The spec wraps pages in `<Pages>` and `<TemplatePages>`, but producers frequently omit
   * those wrappers (and some nest them differently), so the wrapper is used when present
   * and the whole document is scanned otherwise.
   */
  const collectEntries = <T extends { id: string; baseLoc: string }>(
    wrapperName: string,
    itemName: string,
  ): T[] => {
    const wrapper = firstDescendant(documentDoc, wrapperName);
    const containers = wrapper
      ? Array.from(wrapper.children).filter((child) => tagOf(child) === itemName)
      : findAll(documentDoc, itemName);
    const entries: T[] = [];
    const seen = new Set<string>();
    for (const element of containers) {
      const id = attr(element, 'ID');
      const baseLoc = attr(element, 'BaseLoc');
      if (!id || !baseLoc || seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, baseLoc } as T);
    }
    return entries;
  };

  const pages = collectEntries<OfdPageEntry>('Pages', 'Page');
  const templatePages = collectEntries<OfdTemplatePageEntry>('TemplatePages', 'TemplatePage');

  const pageAreaScope = firstDescendant(documentDoc, 'PageArea');
  const pageAreaBox = pageAreaScope ? text(pageAreaScope, 'PhysicalBox') : '';

  const documentResPath = text(documentDoc, 'DocumentRes');
  const publicResPath = text(documentDoc, 'PublicRes');

  // ---- DocumentRes.xml: image resources ----
  const medias: OfdMediaEntry[] = [];
  let mediaBaseLoc = '';
  if (documentResPath) {
    const resPath = resolveArchivePath(docRoot, documentResPath);
    try {
      onProgress?.('解析图片资源表…', 0.16);
      const resDoc = parseXml(await readEntry(resPath), resPath);
      mediaBaseLoc = attr(resDoc.documentElement, 'BaseLoc');
      const list = firstDescendant(resDoc, 'MultiMedias') ?? resDoc.documentElement;
      for (const media of findAll(list, 'MultiMedia')) {
        const id = attr(media, 'ID');
        const mediaFile = text(media, 'MediaFile');
        if (id && mediaFile) {
          medias.push({ id, format: attr(media, 'Format'), mediaFile });
        }
      }
    } catch (error) {
      console.warn('[ofd] DocumentRes.xml 读取失败', error);
    }
  }

  // ---- PublicRes.xml: fonts ----
  const fonts: OfdFontEntry[] = [];
  let fontBaseLoc = '';
  if (publicResPath) {
    const resPath = resolveArchivePath(docRoot, publicResPath);
    try {
      onProgress?.('解析字体资源表…', 0.2);
      const resDoc = parseXml(await readEntry(resPath), resPath);
      fontBaseLoc = attr(resDoc.documentElement, 'BaseLoc');
      for (const font of findAll(resDoc, 'Font')) {
        const id = attr(font, 'ID');
        if (!id) continue;
        fonts.push({
          id,
          familyName: attr(font, 'FamilyName'),
          fontName: attr(font, 'FontName'),
          bold: attr(font, 'Bold') === 'true',
          italic: attr(font, 'Italic') === 'true',
        });
      }
    } catch (error) {
      console.warn('[ofd] PublicRes.xml 读取失败', error);
    }
  }

  return {
    docType: attr(root, 'DocType'),
    version: attr(root, 'Version'),
    docRoot: docXmlName,
    pageAreaBox,
    documentResPath: documentResPath ? resolveArchivePath(docRoot, documentResPath) : '',
    publicResPath: publicResPath ? resolveArchivePath(docRoot, publicResPath) : '',
    pages,
    templatePages,
    medias,
    fonts,
    mediaBaseLoc,
    fontBaseLoc,
    readText: async (path: string) => {
      if (path === docRoot) return readEntry(docXmlName);
      return readEntry(path);
    },
    readBinary: async (path: string) => {
      const resolved = findEntry(path);
      if (!resolved) throw new Error(`压缩包内缺少文件: ${path}`);
      return zip.files[resolved].async('arraybuffer');
    },
    entries: () => names,
  };
}
