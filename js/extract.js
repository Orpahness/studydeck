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
  const pages = [], heights = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push(layoutPage(tc.items, vp.width, vp.height));
    heights.push(vp.height);
    onProgress(i / pdf.numPages);
  }
  const cleaned = dropRepeatedMargins(pages, heights);
  // pages are separated by a form-feed so the app can pick page ranges later
  return { text: cleaned.map((ls) => tidy(ls.map((l) => l.text).join('\n'))).join('\n\f\n'), pages: pdf.numPages };
}

/**
 * Rebuilds reading order from positioned text pieces:
 * - skips rotated text (diagonal watermarks) and oversized decorative titles
 * - detects two-column layouts and reads the left column before the right
 * - puts spaces between pieces that sit apart on the same line ("a." + "Femur")
 */
function layoutPage(raw, W, H) {
  let items = raw.filter((it) => it.str && it.str.trim() && it.transform).map((it) => {
    const [a, b, c, d, x, y] = it.transform;
    const h = Math.hypot(c, d) || it.height || 10;
    return { s: it.str, x, y, w: it.width || it.str.length * h * 0.5, h, rotated: Math.abs(b) > 0.05 * Math.abs(a || 1) || Math.abs(c) > 0.05 * Math.abs(d || 1) };
  });
  items = items.filter((it) => !it.rotated);
  if (!items.length) return [];
  const hs = items.map((it) => it.h).sort((p, q) => p - q);
  const body = hs[Math.floor(hs.length / 2)];
  items = items.filter((it) => it.h <= body * 2.3); // giant banner titles / watermark letters
  // superscripts/subscripts (90⁰, H₂O): snap them onto the line of the text they follow
  const normal = items.filter((it) => it.h >= body * 0.8);
  for (const it of items) {
    if (it.h >= body * 0.8) continue;
    const host = normal.find((n) => Math.abs(n.x + n.w - it.x) < body * 0.6 && Math.abs(n.y - it.y) < body);
    if (host) {
      const up = it.y > host.y;
      const map = up ? '⁰¹²³⁴⁵⁶⁷⁸⁹' : '₀₁₂₃₄₅₆₇₈₉';
      it.s = it.s.replace(/\d/g, (dg) => map[dg]).replace(/\+/g, up ? '⁺' : '₊').replace(/-/g, up ? '⁻' : '₋');
      it.y = host.y; it.h = host.h; it.sup = true;
    }
  }

  // ---- column detection: the right column has a left edge many lines start from,
  // and (almost) no text crosses it
  let split = null;
  const narrow = items.filter((it) => it.w < W * 0.48);
  const starts = new Map();
  for (const it of narrow) if (it.x > W * 0.3 && it.x < W * 0.72) { const k = Math.round(it.x / 3) * 3; starts.set(k, (starts.get(k) || 0) + 1); }
  const edges = [...starts.entries()].filter(([, n]) => n >= 4).map(([x]) => x).sort((p, q) => p - q);
  for (const e of edges) {
    const cut = e - 2;
    const leftN = narrow.filter((it) => it.x + it.w <= cut + 1).length;
    const rightN = narrow.filter((it) => it.x >= cut).length;
    const crossing = narrow.filter((it) => it.x < cut && it.x + it.w > cut + 2).length;
    if (leftN >= 8 && rightN >= 8 && crossing <= Math.max(1, rightN * 0.05)) { split = cut; break; }
  }
  const lineOf = (group) => {
    group.sort((p, q) => (Math.abs(q.y - p.y) > Math.min(p.h, q.h) * 0.45 ? q.y - p.y : p.x - q.x));
    const lines = [];
    for (const it of group) {
      const ln = lines[lines.length - 1];
      const small = ln && it.h < ln.h * 0.8 && Math.abs(ln.y - it.y) < ln.h * 0.8 && it.x >= ln.end - 1; // superscript / subscript (90⁰, H₂O)
      if (ln && (small || Math.abs(ln.y - it.y) <= Math.min(ln.h, it.h) * 0.45)) {
        const gap = it.x - ln.end;
        ln.text += (!small && !it.sup && gap > it.h * 0.12 && !/\s$/.test(ln.text) && !/^\s/.test(it.s) ? ' ' : '') + it.s;
        ln.end = Math.max(ln.end, it.x + it.w);
      } else lines.push({ text: it.s, y: it.y, h: it.h, end: it.x + it.w });
    }
    return lines;
  };
  if (split === null) return lineOf(items);
  // everything above the first numbered item (title block, name/score lines) is a header read first;
  // full-width pieces below it go after the columns
  const numbered = items.filter((it) => /^\s*\d{1,3}\s*[.)](\s|$)/.test(it.s));
  const headerY = numbered.length >= 2 ? Math.max(...numbered.map((it) => it.y)) + body * 0.6 : Infinity;
  const head = items.filter((it) => it.y > headerY);
  const rest = items.filter((it) => it.y <= headerY);
  const spans = (it) => it.x < split - 2 && it.x + it.w > split + 2;
  const cols = rest.filter((it) => !spans(it));
  const mid = cols.length ? cols.map((it) => it.y).sort((p, q) => p - q)[Math.floor(cols.length / 2)] : 0;
  const wide = rest.filter(spans);
  return [
    ...lineOf(head),
    ...lineOf(wide.filter((it) => it.y >= mid && it.y > Math.max(...cols.map((c) => c.y), -Infinity))),
    ...lineOf(cols.filter((it) => it.x + it.w / 2 < split)),
    ...lineOf(cols.filter((it) => it.x + it.w / 2 >= split)),
    ...lineOf(wide.filter((it) => !(it.y >= mid && it.y > Math.max(...cols.map((c) => c.y), -Infinity)))),
  ];
}

/** Removes running headers/footers, page numbers and fill-in form lines (Name: ____). */
function dropRepeatedMargins(pages, heights) {
  const key = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  // only lines in the top 14% / bottom 8% of a page can be running headers or footers
  const inMargin = (l, H) => (l.y > H * 0.88 || l.y < H * 0.055) && !/^\s*([a-hA-H]|\d{1,3})[.)]\s/.test(l.text); // never drop choices / numbered items
  const count = new Map();
  pages.forEach((ls, i) => new Set(ls.filter((l) => inMargin(l, heights[i])).map((l) => key(l.text))).forEach((k) => count.set(k, (count.get(k) || 0) + 1)));
  const minRepeat = pages.length >= 3 ? Math.ceil(pages.length * 0.5) : 2;
  return pages.map((ls, i) => ls.filter((l) => {
    const t = l.text.trim();
    if (pages.length > 1 && inMargin(l, heights[i]) && count.get(key(t)) >= minRepeat) return false;
    if (inMargin(l, heights[i]) && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return false;
    return !isFormLine(t);
  }));
}

export function isFormLine(t) {
  return /^(?:\s*(?:name|school|batch|score|date|section|course|year(?:\s*&\s*section)?|student(?:\s*no\.?)?|id\s*no\.?|instructor|teacher|class|group|rating|signature)\s*:?\s*_{2,}\s*)+$/i.test(t)
    || /^[_\s.:-]{4,}$/.test(t);
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
