// Turns uploaded files into plain text, entirely inside the browser.
// Supports PDF, DOCX, PPTX, TXT, MD, CSV, HTML. (Scanned/image-only PDFs have no
// text layer, so they come back empty and the UI says so.)

let pdfjs;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export const ACCEPT = '.pdf,.docx,.pptx,.txt,.md,.markdown,.csv,.html,.htm,application/pdf,text/plain';

export async function extractText(file, onProgress = () => {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdf(file, onProgress);
  if (name.endsWith('.docx')) return { text: await extractDocx(file), pages: null };
  if (name.endsWith('.pptx')) return { text: await extractPptx(file), pages: null };
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    return { text: tidy(doc.body?.innerText || doc.body?.textContent || ''), pages: null };
  }
  if (/\.(txt|md|markdown|csv)$/.test(name) || file.type.startsWith('text/')) return { text: tidy(await file.text()), pages: null };
  throw new Error('Unsupported file type. Use PDF, DOCX, PPTX, TXT or MD.');
}

async function extractPdf(file, onProgress) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let line = '', lines = [], lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line) { lines.push(line); line = ''; }
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
      lastY = y;
    }
    if (line) lines.push(line);
    out.push(lines.join('\n'));
    onProgress(i / pdf.numPages);
  }
  // pages are separated by a form-feed so the app can pick page ranges later
  return { text: out.map(tidy).join('\n\f\n'), pages: pdf.numPages };
}

// ---- minimal ZIP reader (DOCX/PPTX are zip files) using the browser's DecompressionStream
async function unzip(file, want) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid Office file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const result = {};
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const fname = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(fname)) continue;
    const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    let bytes = raw;
    if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    result[fname] = dec.decode(bytes);
  }
  return result;
}

async function extractDocx(file) {
  const parts = await unzip(file, (n) => n === 'word/document.xml');
  const xml = parts['word/document.xml'] || '';
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [...doc.getElementsByTagNameNS(W, 'p')].map((p) => {
    const style = p.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') || '';
    const txt = [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('');
    if (!txt.trim()) return '';
    const h = /^Heading(\d)/i.exec(style) || /^Title$/i.exec(style);
    if (h) return '#'.repeat(Math.min(Number(h[1]) || 1, 3)) + ' ' + txt;
    if (p.getElementsByTagNameNS(W, 'numPr').length) return '- ' + txt;
    return txt;
  });
  return tidy(paras.join('\n\n'));
}

async function extractPptx(file) {
  const parts = await unzip(file, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const keys = Object.keys(parts).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  return tidy(keys.map((k, i) => {
    const doc = new DOMParser().parseFromString(parts[k], 'application/xml');
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const paras = [...doc.getElementsByTagNameNS(A, 'p')].map((p) => [...p.getElementsByTagNameNS(A, 't')].map((t) => t.textContent).join('')).filter((s) => s.trim());
    return `## Slide ${i + 1}${paras[0] ? ': ' + paras[0] : ''}\n\n${paras.slice(1).map((s) => '- ' + s).join('\n')}`;
  }).join('\n\n'));
}

function tidy(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2') // re-join hyphenated line breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
