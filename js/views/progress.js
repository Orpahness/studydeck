import { db } from '../store.js';
import { esc, icon, pct, timeAgo } from '../util.js';
import { loadStats, dailyActivity } from '../stats.js';
import { areaChart } from '../chart.js';
import { isDue, isMastered } from '../srs.js';

let range = 14;

export async function render(el) {
  const [stats, decks, quizzes] = await Promise.all([loadStats(), db.list('decks'), db.list('quizzes', { select: 'id,title,kind' })]);
  const deckRows = decks.map((d) => {
    const cs = stats.cards.filter((c) => c.deck_id === d.id);
    const logs = stats.logs.filter((l) => l.deck_id === d.id);
    return { d, total: cs.length, due: cs.filter(isDue).length, mastered: cs.filter(isMastered).length, recall: logs.length ? pct(logs.filter((l) => l.rating >= 3).length, logs.length) : null, reviews: logs.length };
  }).sort((a, b) => (a.recall ?? 101) - (b.recall ?? 101));
  const quizName = (id) => quizzes.find((q) => q.id === id)?.title || 'Deleted quiz';
  const attemptsAsc = [...stats.attempts].reverse().slice(-12);

  el.innerHTML = `<div class="stack" style="gap:18px">
    <div class="page-head" style="margin-bottom:0"><div><h1>Progress</h1><p class="sub">How much you're studying and how well it's sticking.</p></div></div>
    <div class="grid stats">
      <div class="card stat"><span class="lbl">${icon('flame')} Day streak</span><span class="num">${stats.streak}</span></div>
      <div class="card stat"><span class="lbl">${icon('target')} Recall rate (6 mo)</span><span class="num">${stats.retention == null ? '—' : stats.retention + '%'}</span></div>
      <div class="card stat"><span class="lbl">${icon('cards')} Cards mastered</span><span class="num">${stats.mastered}<span class="small muted"> / ${stats.cards.length}</span></span></div>
      <div class="card stat"><span class="lbl">${icon('quiz')} Quizzes taken</span><span class="num">${stats.attempts.length}</span></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Daily activity</h3><div class="tiny muted">Flashcard reviews + quiz questions answered</div></div><span class="grow"></span>
        <div class="seg">${[7, 14, 30].map((n) => `<button data-r="${n}" class="${range === n ? 'on' : ''}">${n}d</button>`).join('')}</div></div>
      <div id="act"></div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card">
        <div class="card-head"><div><h3>Quiz scores</h3><div class="tiny muted">Last ${attemptsAsc.length} attempts, %</div></div></div>
        ${attemptsAsc.length >= 2 ? '<div id="scores"></div>' : '<p class="muted small">Take a couple of quizzes to see your trend.</p>'}
        ${stats.attempts.length ? `<div class="stack" style="gap:8px;margin-top:14px">${stats.attempts.slice(0, 5).map((a) => `<a class="row gap" href="#/quiz/${a.quiz_id}" style="color:inherit"><span class="grow small clamp2">${esc(quizName(a.quiz_id))}</span><span class="tiny muted">${timeAgo(a.created_at)}</span><b class="small" style="width:42px;text-align:right">${pct(a.score, a.total)}%</b></a>`).join('')}</div>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Decks to focus on</h3><div class="tiny muted">Lowest recall first</div></div></div>
        ${deckRows.length ? `<div class="stack" style="gap:12px">${deckRows.slice(0, 8).map((r) => `
          <a href="#/decks/${r.d.id}" style="color:inherit"><div class="row gap"><span class="grow small" style="font-weight:500">${esc(r.d.title)}</span><span class="tiny muted">${r.recall == null ? 'not reviewed' : `${r.recall}% recall`}${r.due ? ` · ${r.due} due` : ''}</span></div>
          <div class="progress thin" style="margin-top:6px"><i style="width:${pct(r.mastered, r.total)}%"></i></div>
          <div class="tiny dim" style="margin-top:3px">${r.mastered}/${r.total} mastered</div></a>`).join('')}</div>` : '<p class="muted small">No decks yet.</p>'}
      </div>
    </div>
    <details class="card"><summary class="small muted" style="cursor:pointer">Show activity as a table</summary><div id="tbl" style="margin-top:12px"></div></details>
  </div>`;
  const root = el.firstElementChild;
  const drawAct = () => {
    const act = dailyActivity(stats, range);
    areaChart(root.querySelector('#act'), { values: act.map((d) => d.value), labels: act.map((d) => d.label), highlight: act.length - 1, height: 150 });
    root.querySelector('#tbl').innerHTML = `<table class="prose" style="display:table;width:100%;font-size:13px"><tr><th style="text-align:left">Day</th><th style="text-align:right">Answers</th></tr>${act.map((d) => `<tr><td>${d.label}</td><td style="text-align:right">${d.value}</td></tr>`).join('')}</table>`;
  };
  drawAct();
  if (attemptsAsc.length >= 2) areaChart(root.querySelector('#scores'), { values: attemptsAsc.map((a) => pct(a.score, a.total)), labels: attemptsAsc.map((a) => new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), unit: '%', highlight: attemptsAsc.length - 1 });
  root.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { range = Number(b.dataset.r); root.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b)); drawAct(); } });
}
