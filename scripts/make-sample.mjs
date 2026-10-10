/**
 * Generates a synthetic OFD file with vector content (text, paths, curves, a small raster
 * image and a template page).
 *
 * The reference document for this project is a pure scan, which never exercises the text,
 * path or template branches of the renderer. This fixture does, and doubles as an offline
 * regression check.
 *
 * Usage: node scripts/make-sample.mjs [outPath]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = process.argv[2] ?? path.join(root, 'public', 'samples', 'sample-vector.ofd');

const PAGE_W = 210;
const PAGE_H = 297;

const PAGE_1 = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area><ofd:PhysicalBox>0 0 ${PAGE_W} ${PAGE_H}</ofd:PhysicalBox></ofd:Area>
  <ofd:Content>
    <ofd:Layer ID="40">
      <ofd:PathObject ID="41" Boundary="20 20 170 2" LineWidth="0.6" Stroke="true" CTM="1 0 0 1 0 0">
        <ofd:StrokeColor Value="20 60 140"/>
        <ofd:FillColor Value="20 60 140"/>
        <ofd:AbbreviatedData>M 20 20 L 190 20</ofd:AbbreviatedData>
      </ofd:PathObject>
      <ofd:PathObject ID="42" Boundary="20 30 80 20" LineWidth="0.3" Stroke="true" Fill="true">
        <ofd:FillColor Value="#ee #f2 #fb"/>
        <ofd:StrokeColor Value="#20 #3c #8c"/>
        <ofd:AbbreviatedData>M 20 30 L 100 30 L 100 50 L 20 50 Z</ofd:AbbreviatedData>
      </ofd:PathObject>
      <ofd:PathObject ID="43" Boundary="20 60 120 40" LineWidth="0.4" Stroke="true">
        <ofd:StrokeColor Value="200 30 40"/>
        <ofd:AbbreviatedData>M 20 100 C 50 60 90 140 140 80 Q 160 60 180 95</ofd:AbbreviatedData>
      </ofd:PathObject>
      <ofd:TextObject ID="44" Boundary="20 115 170 12" Font="5" Size="7" Weight="700">
        <ofd:FillColor Value="0 0 0"/>
        <ofd:TextCode X="0" Y="7" DeltaX="g 9 7">OFD 阅读器测试</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="45" Boundary="20 140 170 10" Font="6" Size="5">
        <ofd:FillColor Value="#20 #3c #8c"/>
        <ofd:TextCode X="0" Y="5" DeltaX="g 12 5">AaBbCcDdEeFfGg</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="46" Boundary="20 160 30 40" Font="5" Size="5" ReadDirection="90">
        <ofd:FillColor Value="120 0 130"/>
        <ofd:TextCode X="0" Y="5" DeltaY="g 4 5">竖排文字</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="47" Boundary="60 160 120 10" Font="5" Size="6" Alpha="128">
        <ofd:FillColor Value="0 128 96"/>
        <ofd:TextCode X="0" Y="6" DeltaX="g 9 6">半透明描边文字示例</ofd:TextCode>
        <ofd:StrokeColor Value="0 0 0"/>
      </ofd:TextObject>
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>`;

const PAGE_2 = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area>
    <ofd:PhysicalBox>0 0 ${PAGE_W} ${PAGE_H}</ofd:PhysicalBox>
    <ofd:ApplicationBox>0 0 ${PAGE_W} ${PAGE_H}</ofd:ApplicationBox>
  </ofd:Area>
  <ofd:Template TemplateID="900" ZOrder="Background"/>
  <ofd:Content>
    <ofd:Layer ID="50">
      <ofd:ImageObject ID="51" ResourceID="700" Boundary="25 180 60 45" CTM="60 0 0 45 25 180"/>
      <ofd:TextObject ID="52" Boundary="25 130 160 10" Font="5" Size="6">
        <ofd:FillColor Value="0 0 0"/>
        <ofd:TextCode X="0" Y="6" DeltaX="g 10 6">内嵌图片与模板页测试</ofd:TextCode>
      </ofd:TextObject>
      <ofd:PathObject ID="53" Boundary="25 240 160 1" LineWidth="0.4" Stroke="true" DashPattern="3 2">
        <ofd:StrokeColor Value="90 90 90"/>
        <ofd:AbbreviatedData>M 25 240 L 185 240</ofd:AbbreviatedData>
      </ofd:PathObject>
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>`;

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area><ofd:PhysicalBox>0 0 ${PAGE_W} ${PAGE_H}</ofd:PhysicalBox></ofd:Area>
  <ofd:Content>
    <ofd:Layer ID="60">
      <ofd:PathObject ID="61" Boundary="0 0 ${PAGE_W} ${PAGE_H}" LineWidth="2" Stroke="true">
        <ofd:StrokeColor Value="#b8 #c4 #d8"/>
        <ofd:AbbreviatedData>M 10 10 L ${PAGE_W - 10} 10 L ${PAGE_W - 10} ${PAGE_H - 10} L 10 ${PAGE_H - 10} Z</ofd:AbbreviatedData>
      </ofd:PathObject>
      <ofd:TextObject ID="62" Boundary="14 14 120 8" Font="5" Size="5">
        <ofd:FillColor Value="150 150 150"/>
        <ofd:TextCode X="0" Y="5" DeltaX="g 14 5">模板背景层</ofd:TextCode>
      </ofd:TextObject>
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>`;

/** A tiny solid-colour PNG (no dependencies — CRC32 is implemented inline). */
function makePng(width, height, [r, g, b]) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // no filter
    for (let x = 0; x < width; x += 1) {
      // Simple diagonal gradient so the image is obviously an image.
      const shade = (x + y) % 16;
      row[1 + x * 3] = Math.min(255, r + shade * 4);
      row[2 + x * 3] = Math.min(255, g + shade * 4);
      row[3 + x * 3] = Math.min(255, b + shade * 4);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const zip = new JSZip();
zip.file(
  'OFD.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" DocType="OFD" Version="1.1">
  <ofd:DocBody>
    <ofd:DocInfo>
      <ofd:DocID>vector-sample-0001</ofd:DocID>
      <ofd:Creator>ofd-reader sample generator</ofd:Creator>
    </ofd:DocInfo>
    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>
  </ofd:DocBody>
</ofd:OFD>`,
);

zip.file(
  'Doc_0/Document.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData>
    <ofd:MaxUnitID>999</ofd:MaxUnitID>
    <ofd:PageArea><ofd:PhysicalBox>0 0 ${PAGE_W} ${PAGE_H}</ofd:PhysicalBox></ofd:PageArea>
    <ofd:PublicRes>PublicRes.xml</ofd:PublicRes>
    <ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>
    <ofd:TemplatePage ID="900" Name="边框模板" BaseLoc="Templates/Tpl_0/Content.xml"/>
  </ofd:CommonData>
  <ofd:Pages>
    <ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>
    <ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml"/>
  </ofd:Pages>
</ofd:Document>`,
);

zip.file(
  'Doc_0/PublicRes.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res">
  <ofd:Fonts>
    <ofd:Font ID="5" FontName="SimSun" FamilyName="SimSun" Charset="unicode"/>
    <ofd:Font ID="6" FontName="Arial" FamilyName="Arial"/>
  </ofd:Fonts>
</ofd:Res>`,
);

zip.file(
  'Doc_0/DocumentRes.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res">
  <ofd:MultiMedias>
    <ofd:MultiMedia ID="700" Type="Image" Format="PNG">
      <ofd:MediaFile>gradient.png</ofd:MediaFile>
    </ofd:MultiMedia>
  </ofd:MultiMedias>
</ofd:Res>`,
);

zip.file('Doc_0/Pages/Page_0/Content.xml', PAGE_1);
zip.file('Doc_0/Pages/Page_1/Content.xml', PAGE_2);
zip.file('Doc_0/Templates/Tpl_0/Content.xml', TEMPLATE);
zip.file('Doc_0/Res/gradient.png', makePng(240, 180, [30, 90, 200]));

const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buffer);
console.log(`wrote ${outPath} (${buffer.length} bytes)`);
