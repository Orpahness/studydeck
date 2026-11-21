import { db } from '../store.js';
import { state, go, folderById, focusId, setFocus } from '../app.js';
import { esc, icon, timeAgo, pct, confirmBox, promptBox, toast } from '../util.js';
import { openSourcePicker } from '../create.js';

let tab = 'all';

export async function render(el) {
  const [quizzes, attempts] = await Promise.all([
    db.list('quizzes', { select: 'id,title,kind,questions,time_limit_min,folder_id,source_label,created_at', order: 'created_at', desc: true }),
    db.list('quiz_attempts', { select: 'id,quiz_id,score,total,created_at', order: 'created_at', desc: true }),
  ]);
  const fid = focusId();
  const rows = quizzes.filter((q) => (tab === 'all' || q.kind === tab) && (!fid || q.folder_id === fid));
  el.innerHTML = `<div>
    <div class="page-head"><div><h1>Quizzes & exams</h1><p class="sub">Quizzes give feedback after every question. Exams are timed and graded at the end.</p></div>
      <span class="grow"></span><div class="row gap"><button class="btn" data-new="exam">${icon('clock')} New exam</button><button class="btn primary" data-new="quiz">${icon('sparkle')} New quiz</button></div></div>
    <div class="seg" style="margin-bottom:16px"><button data-t="all" class="${tab === 'all' ? 'on' : ''}">All</button><button data-t="quiz" class="${tab === 'quiz' ? 'on' : ''}">Quizzes</button><button data-t="exam" class="${tab === 'exam' ? 'on' : ''}">Exams</button></div>
    ${state.folders.length ? `<div class="chips" style="margin-bottom:16px"><span class="small muted" style="align-self:center">Studying:</span><button class="chip ${!fid ? 'active' : ''}" data-f="">All</button>${state.folders.map((f) => `<button class="chip ${fid === f.id ? 'active' : ''}" data-f="${f.id}"><span class="swatch" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join('')}</div>` : ''}
    ${rows.length ? `<div class="list">${rows.map((q) => {
      const at = attempts.filter((a) => a.quiz_id === q.id);
      const best = at.length ? Math.max(...at.map((a) => pct(a.score, a.total))) : null;
      return `<div class="item" data-id="${q.id}">
        <span class="item-ico">${icon(q.kind === 'exam' ? 'clock' : 'quiz')}</span>
        <div class="grow"><div class="item-title">${esc(q.title)}</div>
          <div class="item-meta"><span class="when">${q.kind === 'exam' ? 'Exam' : 'Quiz'}</span><span>${q.questions.length} questions</span>${q.time_limit_min ? `<span>${q.time_limit_min} min</span>` : ''}${q.folder_id && folderById(q.folder_id) ? `<span>${esc(folderById(q.folder_id).name)}</span>` : ''}<span>${at.length ? `${at.length} attempt${at.length > 1 ? 's' : ''} · best ${best}%` : 'Not taken yet'}</span><span>${timeAgo(q.created_at)}</span></div></div>
        <div class="row gap"><button class="btn sm primary" data-a="take">${at.length ? 'Retake' : 'Start'}</button>
          <button class="btn sm" data-a="learn" title="Learn mode: missed questions repeat until you get them right">${icon('target')} Learn</button>
          <button class="icon-btn sm ghost" data-a="ren" aria-label="Rename">${icon('edit')}</button>
          <button class="icon-btn sm ghost" data-a="del" aria-label="Delete">${icon('trash')}</button></div>
      </div>`; }).join('')}</div>`
    : quizzes.length ? `<div class="empty small">Nothing here for this subject yet.</div>` : `<div class="empty">${icon('quiz')}<h3>Nothing here yet</h3><p class="small">Pick a note or PDF and StudyDeck writes the questions for you.</p><button class="btn primary" data-new="quiz">${icon('sparkle')} Make a quiz</button></div>`}
  </div>`;
  const root = el.firstElementChild;
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; return render(el); }
    const f = e.target.closest('[data-f]'); if (f) { await setFocus(f.dataset.f || null); return render(el); }
    const n = e.target.closest('[data-new]'); if (n) return openSourcePicker(n.dataset.new);
    const row = e.target.closest('[data-id]'); if (!row) return;
    const q = quizzes.find((x) => x.id === row.dataset.id);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'del') {
      if (await confirmBox({ title: `Delete “${q.title}”?`, message: 'The questions and all past scores are erased permanently.' })) { await db.remove('quizzes', q.id); toast('Deleted'); render(el); }
      return;
    }
    if (a === 'learn') return go(`#/learn/quiz/${q.id}`);
    if (a === 'ren') { const t2 = await promptBox({ title: 'Rename', label: 'Title', value: q.title }); if (t2) { await db.update('quizzes', q.id, { title: t2 }); render(el); } return; }
    go(`#/quiz/${q.id}`);
  });
}
