// Export typed notes to PDF or Word (.docx), entirely in the browser.
// Understands simple Markdown: # headings, - bullets, 1. numbered lists, **bold**, *italic*.

// ---------------------------------------------------------------- parsing
function inline(text) {
  const runs = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index) });
    if (m[2] != null) runs.push({ t: m[2], b: true }); else runs.push({ t: m[4], i: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ t: text.slice(last) });
  return runs.filter((r) => r.t);
}

export function parseBlocks(md) {
  const out = [];
  for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { out.push({ kind: 'gap' }); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) out.push({ kind: 'h', level: m[1].length, runs: inline(m[2]) });
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) out.push({ kind: 'li', runs: inline(m[1]) });
    else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) out.push({ kind: 'ol', n: m[1], runs: inline(m[2]) });
    else out.push({ kind: 'p', runs: inline(line) });
  }
  // collapse repeated gaps
  return out.filter((b, i) => !(b.kind === 'gap' && (i === 0 || out[i - 1].kind === 'gap')));
}

const safeName = (t) => (t || 'notes').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'notes';
function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- PDF
const WINANSI_EXTRA = '‘’“”–—•…€™';
const pdfSafe = (s) => s.replace(/\t/g, '    ').replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => (WINANSI_EXTRA.includes(c) ? c : c === '→' ? '->' : c === '←' ? '<-' : '?'));

export async function exportPdf(title, md) {
  const { PDFDocument, StandardFonts, rgb } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  const doc = await PDFDocument.create();
  doc.setTitle(title || 'Notes');
  doc.setCreator('StudyDeck');
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const W = 595.28, H = 841.89, M = 56, maxW = W - M * 2;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.12, 0.2), muted = rgb(0.42, 0.45, 0.55), accent = rgb(0.23, 0.38, 0.94);
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (h) => { if (y - h < M) newPage(); };

  function writeRuns(runs, { size = 11, indent = 0, color = ink, bold = false, lead = 1.45 } = {}) {
    const words = [];
    for (const r of runs) {
      const font = (r.b || bold) && r.i ? F.bi : (r.b || bold) ? F.b : r.i ? F.i : F.r;
      for (const part of pdfSafe(r.t).split(/(\s+)/)) if (part) words.push({ text: part, font });
    }
    const lineH = size * lead;
    let line = [], width = 0;
    const flush = () => {
      ensure(lineH);
      let x = M + indent;
      // draw runs of same-font words together so copied text keeps its spaces
      const segs = [];
      for (const w of line) { const last = segs[segs.length - 1]; if (last && last.font === w.font) last.text += w.text; else segs.push({ ...w }); }
      for (const sg of segs) { page.drawText(sg.text, { x, y: y - size, size, font: sg.font, color }); x += sg.font.widthOfTextAtSize(sg.text, size); }
      y -= lineH; line = []; width = 0;
    };
    for (const w of words) {
      let ww = w.font.widthOfTextAtSize(w.text, size);
      if (/^\s+$/.test(w.text)) { if (line.length) { line.push(w); width += ww; } continue; }
      // break very long words (URLs) so they never run off the page
      while (ww > maxW - indent) {
        let cut = w.text.length;
        while (cut > 1 && w.font.widthOfTextAtSize(w.text.slice(0, cut), size) > maxW - indent - width) cut--;
        line.push({ ...w, text: w.text.slice(0, cut) }); flush();
        w.text = w.text.slice(cut); ww = w.font.widthOfTextAtSize(w.text, size);
      }
      if (width + ww > maxW - indent && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
        flush();
      }
      line.push(w); width += ww;
    }
    if (line.length) flush();
  }

  writeRuns([{ t: title || 'Notes' }], { size: 22, bold: true, lead: 1.25 });
  writeRuns([{ t: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) }], { size: 10, color: muted });
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: accent, opacity: 0.6 });
  y -= 16;

  for (const b of parseBlocks(md)) {
    if (b.kind === 'gap') { y -= 6; continue; }
    if (b.kind === 'h') {
      const size = [0, 17, 14.5, 12.5][b.level];
      y -= 8; ensure(size * 2.4);
      writeRuns(b.runs, { size, bold: true, lead: 1.3 });
      y -= 2;
    } else if (b.kind === 'li' || b.kind === 'ol') {
      ensure(16);
      const mark = b.kind === 'li' ? '•' : `${b.n}.`;
      page.drawText(mark, { x: M + 8, y: y - 11, size: 11, font: F.r, color: ink });
      writeRuns(b.runs, { indent: 24 });
    } else writeRuns(b.runs);
  }
  // page numbers
  const pages = doc.getPages();
  pages.forEach((p, k) => p.drawText(`${k + 1} / ${pages.length}`, { x: W - M - 30, y: 28, size: 9, font: F.r, color: muted }));
  download(new Blob([await doc.save()], { type: 'application/pdf' }), `${safeName(title)}.pdf`);
}

// ---------------------------------------------------------------- DOCX (hand-built Office Open XML in a zip)
const xmlEsc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const runXml = (r) => `<w:r>${r.b || r.i ? `<w:rPr>${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.t)}</w:t></w:r>`;

export async function exportDocx(title, md) {
  const body = [];
  body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runXml({ t: title || 'Notes' })}</w:p>`);
  body.push(`<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>${runXml({ t: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) })}</w:p>`);
  for (const b of parseBlocks(md)) {
    if (b.kind === 'gap') continue;
    if (b.kind === 'h') body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${b.runs.map(runXml).join('')}</w:p>`);
    else if (b.kind === 'li' || b.kind === 'ol') body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="567" w:hanging="283"/></w:pPr>${runXml({ t: b.kind === 'li' ? '•\t' : `${b.n}.\t` })}${b.runs.map(runXml).join('')}</w:p>`);
    else body.push(`<w:p>${b.runs.map(runXml).join('')}</w:p>`);
  }
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(title || 'Notes')}</dc:title><dc:creator>StudyDeck</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="1A1F33"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="3A62F0"/></w:pBdr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="6B7390"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1A1F33"/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2A3A80"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:tabs><w:tab w:val="left" w:pos="567"/></w:tabs></w:pPr></w:style>
</w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  download(new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), `${safeName(title)}.docx`);
}

// minimal ZIP writer (stored, no compression) — enough for Office files
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name), data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}
