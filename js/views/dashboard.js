import { db } from '../store.js';
import { state, go, folderById, focusId, setFocus, ensureFolder } from '../app.js';
import { esc, icon, timeAgo, debounce, pct, $$, promptBox, toast } from '../util.js';
import { loadStats, dailyActivity } from '../stats.js';
import { areaChart } from '../chart.js';
import { isDue, isMastered } from '../srs.js';
import { openSourcePicker, importAsNotes, importToLibrary, pickFiles } from '../create.js';

let filter = null; // folder id of the subject being studied (null = all)
const DRAFT_KEY = 'studydeck.writerDraft';

export async function render(el) {
  filter = focusId();
  const [stats, notes, decks, quizzes, docs] = await Promise.all([
    loadStats(),
    db.list('notes', { select: 'id,title,content,tags,folder_id,updated_at,pinned', order: 'updated_at', desc: true, limit: 50 }),
    db.list('decks', { order: 'created_at', desc: true }),
    db.list('quizzes', { select: 'id,title,kind,questions,folder_id,created_at,time_limit_min', order: 'created_at', desc: true, limit: 30 }),
    db.list('documents', { select: 'id,title,file_type,page_count,size_bytes,created_at', order: 'created_at', desc: true, limit: 3 }),
  ]);
  const name = (state.profile?.display_name || '').split(' ')[0];
  const by = (rows) => (filter ? rows.filter((r) => r.folder_id === filter) : rows);

  // deck summaries
  const deckInfo = by(decks).map((d) => {
    const cs = stats.cards.filter((c) => c.deck_id === d.id);
    return { ...d, total: cs.length, due: cs.filter(isDue).length, mastered: cs.filter(isMastered).length };
  }).sort((a, b) => b.due - a.due);
  const focus = deckInfo.find((d) => d.due) || deckInfo[0];
  const lastAttempt = (qid) => stats.attempts.find((a) => a.quiz_id === qid);
  const goal = state.profile?.daily_goal || 20;

  el.innerHTML = `
  <div class="dash">
    <div class="stack" style="gap:20px;min-width:0">
      <div class="hero">
        <h1><span class="grad">${name ? `Hi ${esc(name)},` : 'Make studying'}</span> ${name ? 'ready to study?' : 'simple!'}</h1>
        <p>Your notes, flashcards and practice tests in one place. A little every day keeps it all fresh.</p>
      </div>
      <div class="row gap subject-row" style="flex-wrap:nowrap;min-width:0">
        <div class="chips grow" role="radiogroup" aria-label="Subject you're studying">
          <span class="small muted" style="align-self:center;white-space:nowrap;padding-right:2px">Studying:</span>
          <button class="chip ${!filter ? 'active' : ''}" data-f="" role="radio" aria-checked="${!filter}">${filter ? '' : '<span class="swatch" style="background:var(--good)"></span>'}All subjects</button>
          ${state.folders.map((f) => `<button class="chip ${filter === f.id ? 'active' : ''}" data-f="${f.id}" role="radio" aria-checked="${filter === f.id}"><span class="swatch" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join('')}
          <button class="chip" data-act="add-subject" title="Add a subject">${icon('plus')} Subject</button>
        </div>
        <button class="btn dark" id="new-btn">${icon('plus')}<span>New</span></button>
      </div>

      <div class="list">
        ${focus ? deckItem(focus) : `<div class="item hl" data-go="#/notes">
            <span class="item-ico big">${icon('sparkle')}</span>
            <div class="grow"><div class="item-meta" style="margin:0 0 4px"><span class="when">${icon('target')} Get started</span></div>
            <div class="item-title">Upload your first notes or a PDF</div>
            <p class="small muted" style="margin-top:4px">StudyDeck files them by subject, then turns them into flashcards, quizzes and exams.</p>
            <div class="row gap wrap" style="margin-top:14px"><button class="btn primary sm" data-act="up-notes">${icon('upload')} Upload notes</button><button class="btn sm" data-act="gen">${icon('sparkle')} Generate from a PDF</button></div></div></div>`}
        ${by(notes).slice(0, 3).map((n) => `
          <div class="item" data-go="#/notes/${n.id}">
            <span class="item-ico">${icon('note')}</span>
            <div class="grow"><div class="item-meta" style="margin:0 0 3px"><span class="when">${icon('clock')} Edited ${timeAgo(n.updated_at)}</span>${n.folder_id && folderById(n.folder_id) ? `<span>${esc(folderById(n.folder_id).name)}</span>` : ''}</div>
              <div class="item-title">${esc(n.title)}</div>
              <p class="small muted clamp2" style="margin-top:2px">${esc(n.content.replace(/[#*>`_-]/g, '').slice(0, 220))}</p></div>
            <button class="icon-btn sm" data-gen-note="${n.id}" title="Make flashcards or a quiz from this">${icon('sparkle')}</button>
          </div>`).join('')}
        ${by(quizzes).slice(0, 2).map((q) => { const a = lastAttempt(q.id); return `
          <div class="item" data-go="#/quiz/${q.id}">
            <span class="item-ico">${icon(q.kind === 'exam' ? 'clock' : 'quiz')}</span>
            <div class="grow"><div class="item-meta" style="margin:0 0 3px"><span class="when">${icon(a ? 'check' : 'play')} ${a ? `Last score ${pct(a.score, a.total)}%` : 'Not taken yet'}</span><span>${q.kind === 'exam' ? 'Exam' : 'Quiz'} · ${q.questions.length} questions${q.time_limit_min ? ` · ${q.time_limit_min} min` : ''}</span></div>
              <div class="item-title">${esc(q.title)}</div></div>
            <button class="btn sm">${a ? 'Retake' : 'Start'}</button>
          </div>`; }).join('')}
      </div>

      <div class="grid stats">
        <div class="card stat"><span class="lbl">${icon('flame')} Day streak</span><span class="num">${stats.streak}</span></div>
        <div class="card stat"><span class="lbl">${icon('cards')} Cards due</span><span class="num">${stats.due}</span></div>
        <div class="card stat"><span class="lbl">${icon('target')} Mastered</span><span class="num">${stats.mastered}<span class="muted small"> / ${stats.cards.length}</span></span></div>
        <div class="card stat"><span class="lbl">${icon('quiz')} Avg quiz score</span><span class="num">${stats.avgScore == null ? '—' : stats.avgScore + '%'}</span></div>
      </div>

      <div class="card writer" id="writer">
        <div class="card-head"><span class="item-ico" style="width:38px;height:38px;border-radius:11px">${icon('edit')}</span><div><h3>Write notes</h3><div class="tiny muted">Type here, then save to Notes or download as PDF / Word</div></div><span class="grow"></span><span class="tiny dim" id="w-state"></span></div>
        <input class="title-in" id="w-title" placeholder="Title (e.g. Chapter 3 summary)" aria-label="Title">
        <textarea class="textarea" id="w-body" placeholder="Start typing…&#10;# Heading   - bullet   1. numbered   **bold**   *italic*"></textarea>
        <div class="row gap wrap" style="margin-top:12px">
          <button class="btn primary sm" data-w="save">${icon('note')} Save to notes</button>
          <button class="btn sm" data-w="pdf">${icon('download')} PDF</button>
          <button class="btn sm" data-w="docx">${icon('download')} Word</button>
          <span class="grow"></span>
          <button class="btn ghost sm" data-w="clear">Clear</button>
        </div>
      </div>
    </div>

    <aside class="dash-side">
      <div class="card sky quick-note">
        <div class="card-head"><h3>Today's note</h3><span class="grow"></span><span class="tiny" id="qn-state" style="color:#dfe6ff"></span></div>
        <textarea id="qn" placeholder="Jot down what to study today…" aria-label="Today's note">${esc(state.profile?.quick_note || '')}</textarea>
        <div class="row between" style="margin-top:12px">
          <span class="small" style="color:#dfe6ff">${icon('target')} ${stats.reviewedToday}/${goal} cards today</span>
          <span class="pct-badge">${Math.min(100, pct(stats.reviewedToday, goal))}%</span>
        </div>
        <div class="progress thin" style="margin-top:8px;background:rgba(0,0,0,.25)"><i style="width:${Math.min(100, pct(stats.reviewedToday, goal))}%;background:#fff"></i></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>My files</h3><span class="grow"></span><button class="icon-btn sm" data-go="#/library" aria-label="Open library">${icon('arrow')}</button></div>
        ${docs.length ? `<div class="stack" style="gap:8px">${docs.map((d) => `<a class="row gap" href="#/library/${d.id}" style="color:inherit;padding:6px 0"><span class="item-ico" style="width:38px;height:38px;border-radius:11px">${icon('book')}</span><div class="grow"><div class="small clamp2" style="font-weight:500">${esc(d.title)}</div><div class="tiny muted">${d.page_count ? d.page_count + ' pages · ' : ''}${timeAgo(d.created_at)}</div></div></a>`).join('')}</div>`
          : `<div class="empty" style="padding:16px 0">${icon('folder')}<p class="small">You haven't added a file yet</p></div>`}
        <div class="row between" style="margin-top:12px"><span class="tiny dim">PDF · Word · PowerPoint · Text</span><button class="btn sm" data-act="add-file">${icon('plus')} Add file</button></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Activity</h3><div class="tiny muted">${dailyActivity(stats, 7).reduce((s, d) => s + d.value, 0)} answers this week</div></div><span class="grow"></span><button class="btn sm" data-go="#/progress">Report ${icon('arrow')}</button></div>
        <div id="act-chart"></div>
      </div>
    </aside>
  </div>`;

  el.querySelector('.subject-row .chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  const act = dailyActivity(stats, 7);
  areaChart(el.querySelector('#act-chart'), { values: act.map((d) => d.value), labels: act.map((d) => d.label), highlight: act.length - 1 });

  // ------- events (bound to the fresh root so re-renders don't stack listeners)
  el.firstElementChild.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-f]');
    if (f) {
      await setFocus(f.dataset.f || null);
      const name = folderById(f.dataset.f)?.name;
      toast(name ? `Studying ${name} — new uploads and quizzes go here` : 'Showing all subjects — uploads are sorted automatically');
      return render(el);
    }
    const w = e.target.closest('[data-w]');
    if (w) return writerAction(w.dataset.w);
    const gn = e.target.closest('[data-gen-note]');
    if (gn) {
      e.stopPropagation();
      const n = await db.get('notes', gn.dataset.genNote);
      const { openGenerator } = await import('../create.js');
      return openGenerator({ text: n.content, title: n.title, folder_id: n.folder_id, source: n.title });
    }
    const a = e.target.closest('[data-act]');
    if (a) {
      e.stopPropagation();
      if (a.dataset.act === 'up-notes') { const fl = await pickFiles(); if (fl.length && (await importAsNotes(fl)).length) render(el); }
      if (a.dataset.act === 'add-file') { const fl = await pickFiles(); if (fl.length && (await importToLibrary(fl)).length) render(el); }
      if (a.dataset.act === 'gen') openSourcePicker('quiz');
      if (a.dataset.act === 'add-subject') {
        const name = await promptBox({ title: 'Add a subject', label: 'What are you studying? (e.g. Anatomy, Accounting 2)', confirmText: 'Add & study' });
        if (name) { await setFocus(await ensureFolder(name)); render(el); }
      }
      if (a.dataset.act === 'study') go(`#/study/${a.dataset.id}`);
      return;
    }
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
  });
  el.querySelector('#new-btn').addEventListener('click', (e) => { e.stopPropagation(); newMenu(e.currentTarget, el); });

  // ---- writer: draft kept on this device until saved or cleared
  const wt = el.querySelector('#w-title'), wb = el.querySelector('#w-body'), ws = el.querySelector('#w-state');
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); wt.value = d.title || ''; wb.value = d.body || ''; } catch { /* ignore */ }
  const saveDraft = debounce(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: wt.value, body: wb.value })); ws.textContent = 'Draft saved'; } catch { /* ignore */ } }, 400);
  wt.addEventListener('input', saveDraft); wb.addEventListener('input', saveDraft);
  async function writerAction(k) {
    const title = wt.value.trim() || 'My notes';
    if (k === 'clear') { if (!wb.value || confirm('Clear this draft?')) { wt.value = ''; wb.value = ''; localStorage.removeItem(DRAFT_KEY); ws.textContent = ''; } return; }
    if (!wb.value.trim()) return toast('Write something first', 'err');
    if (k === 'save') {
      const { autoTags, detectSubject } = await import('../generator.js');
      const n = await db.insert('notes', { title, content: wb.value, tags: autoTags(wb.value), folder_id: filter || await ensureFolder(detectSubject(wb.value)) });
      wt.value = ''; wb.value = ''; localStorage.removeItem(DRAFT_KEY); ws.textContent = '';
      toast('Saved to your notes', 'ok');
      return go(`#/notes/${n.id}`);
    }
    try {
      const ex = await import('../export.js');
      if (k === 'pdf') await ex.exportPdf(title, wb.value); else await ex.exportDocx(title, wb.value);
      toast(`Downloaded ${k === 'pdf' ? 'PDF' : 'Word file'}`, 'ok');
    } catch (err) { toast('Export failed: ' + err.message, 'err'); }
  }

  const qn = el.querySelector('#qn'), qs = el.querySelector('#qn-state');
  const save = debounce(async () => { state.profile = await db.saveProfile({ quick_note: qn.value }); qs.textContent = 'Saved'; }, 700);
  qn.addEventListener('input', () => { qs.textContent = 'Saving…'; save(); });

  function deckItem(d) {
    const p = pct(d.mastered, d.total);
    return `<div class="item hl" data-go="#/decks/${d.id}">
      <span class="item-ico big">${icon('cards')}</span>
      <div class="grow">
        <div class="item-meta" style="margin:0 0 4px"><span class="when">${icon('clock')} ${d.due ? `${d.due} card${d.due > 1 ? 's' : ''} due now` : 'All caught up'}</span>${d.folder_id && folderById(d.folder_id) ? `<span class="tag">${esc(folderById(d.folder_id).name)}</span>` : ''}</div>
        <div class="item-title" style="font-size:17px">${esc(d.title)}</div>
        <p class="small muted" style="margin-top:3px">${d.total} flashcards${d.source_label ? ` · from ${esc(d.source_label)}` : ''}</p>
        <div class="row gap mastery-row" style="margin-top:14px">
          <span class="small muted">Mastery</span>
          <div class="progress grow" style="max-width:260px;min-width:110px"><i style="width:${Math.max(p, 3)}%"></i></div>
          <span class="pct-badge">${p}%</span>
          <span class="grow"></span>
          <button class="btn primary sm" data-act="study" data-id="${d.id}">${icon('play')} ${d.due ? 'Review' : 'Practice'}</button>
        </div>
      </div></div>`;
  }
}

function newMenu(anchor, el) {
  $$('.menu').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu';
  m.style.top = `${r.bottom + 8 + window.scrollY}px`;
  m.style.right = `${Math.max(10, innerWidth - r.right)}px`;
  m.innerHTML = `
    <button data-k="note">${icon('edit')} Write a note</button>
    <button data-k="up">${icon('upload')} Upload notes</button>
    <button data-k="file">${icon('book')} Add PDF / book</button>
    <button data-k="cards">${icon('cards')} Make flashcards</button>
    <button data-k="quiz">${icon('quiz')} Make a quiz</button>
    <button data-k="exam">${icon('clock')} Make an exam</button>`;
  document.body.append(m);
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off, true); } };
  setTimeout(() => document.addEventListener('click', off, true));
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    m.remove();
    const k = b.dataset.k;
    if (k === 'note') { const n = await db.insert('notes', { title: 'Untitled note', content: '', folder_id: filter }); go(`#/notes/${n.id}`); }
    if (k === 'up') { const fl = await pickFiles(); if (fl.length && (await importAsNotes(fl)).length) render(el); }
    if (k === 'file') { const fl = await pickFiles(); if (fl.length && (await importToLibrary(fl)).length) render(el); }
    if (['cards', 'quiz', 'exam'].includes(k)) openSourcePicker(k);
  });
}
