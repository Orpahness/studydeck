import { marked } from '../vendor/marked/marked.esm.js';
import { esc } from './util.js';

marked.use({ gfm: true, breaks: true, renderer: { html: (t) => esc(t.text ?? t.raw ?? '') } });

/** Markdown → safe HTML (raw HTML escaped; scripts, handlers and js: links stripped). */
export function renderMd(src, highlight = '') {
  const html = marked.parse(src || '');
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*(javascript|data):/i.test(a.value))) n.removeAttribute(a.name);
    }
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
  const root = doc.body.firstElementChild;
  if (highlight) {
    const re = new RegExp(highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
    for (const t of hits) {
      const span = doc.createElement('span');
      span.innerHTML = esc(t.nodeValue).replace(new RegExp(esc(highlight).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
      t.replaceWith(span);
    }
  }
  return root.innerHTML;
}
