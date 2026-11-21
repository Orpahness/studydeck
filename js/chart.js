// Tiny single-series area chart with a hatched fill (matches the dashboard
// style) and a hover/tap tooltip. Single series → no legend; the card title names it.
import { esc } from './util.js';

let n = 0;
export function areaChart(el, { values, labels, unit = '', highlight = null, height = 130 }) {
  const id = `hatch${n++}`;
  const W = 320, H = height, padX = 8, top = 26, bottom = 22;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (W - padX * 2) / (values.length - 1) : 0;
  const x = (i) => padX + i * step;
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `${line}L${x(values.length - 1)},${H - bottom}L${x(0)},${H - bottom}Z`;
  const hi = highlight ?? values.indexOf(Math.max(...values));
  const every = Math.ceil(labels.length / 7); // thin axis labels; tooltip still shows each one
  const showLbl = (i) => i === hi || i === labels.length - 1 || (i % every === 0 && Math.abs(i - hi) >= every && labels.length - 1 - i >= every);
  el.innerHTML = `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(labels.map((l, i) => `${l}: ${values[i]}${unit}`).join(', '))}">
      <defs><pattern id="${id}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="7" fill="rgba(160,180,255,0.22)"/></pattern>
      <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4f7cff" stop-opacity=".35"/><stop offset="1" stop-color="#4f7cff" stop-opacity="0"/></linearGradient></defs>
      <line x1="${padX}" x2="${W - padX}" y1="${H - bottom}" y2="${H - bottom}" stroke="rgba(160,180,255,.15)"/>
      <path d="${area}" fill="url(#${id})"/><path d="${area}" fill="url(#${id}g)"/>
      <path d="${line}" fill="none" stroke="#7b9bff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="cx" x1="0" x2="0" y1="${top - 6}" y2="${H - bottom}" stroke="#fff" stroke-opacity=".5" stroke-dasharray="3 3" visibility="hidden"/>
      <circle class="cd" r="5" fill="#fff" stroke="#4f7cff" stroke-width="3" visibility="hidden"/>
      ${labels.map((l, i) => !showLbl(i) ? '' : `<text x="${x(i)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}" font-size="10" fill="${i === hi ? '#eaf0ff' : '#66729e'}">${esc(l)}</text>`).join('')}
      <rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
    </svg><div class="chart-tip hidden"></div></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip'), cx = svg.querySelector('.cx'), cd = svg.querySelector('.cd');
  const show = (i) => {
    const [px, py] = pts[i];
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cd.setAttribute('cx', px); cd.setAttribute('cy', py);
    cx.setAttribute('visibility', 'visible'); cd.setAttribute('visibility', 'visible');
    const r = svg.getBoundingClientRect(), s = r.width / W;
    tip.style.left = `${px * s}px`; tip.style.top = `${py * s}px`;
    tip.textContent = `${labels[i]} · ${values[i]}${unit}`;
    tip.classList.remove('hidden');
  };
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.touches?.[0]?.clientX ?? e.clientX) - r.left) * (W / r.width);
    show(Math.max(0, Math.min(values.length - 1, Math.round((px - padX) / (step || 1)))));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => (values.length ? show(hi) : null));
  if (values.length) requestAnimationFrame(() => show(hi));
}

/** Score ring for quiz results. */
export function ring(pct, size = 150) {
  const r = 60, c = 2 * Math.PI * r;
  const col = pct >= 75 ? '#34d399' : pct >= 50 ? '#7b9bff' : '#f87185';
  return `<svg class="score-ring" viewBox="0 0 150 150" width="${size}" height="${size}" role="img" aria-label="Score ${pct}%">
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
    ${pct > 0 ? '' : '<!--'}<circle cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(c * pct) / 100} ${c}" transform="rotate(-90 75 75)"/>${pct > 0 ? '' : '-->'}
    <text x="75" y="82" text-anchor="middle" font-size="30" font-weight="700" fill="#eaf0ff">${pct}%</text></svg>`;
}
