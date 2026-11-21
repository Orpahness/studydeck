import { db, files } from '../store.js';
import { state, go, setCrumb, folderById } from '../app.js';
import { esc, icon, timeAgo, fmtBytes, toast, confirmBox, promptBox } from '../util.js';
import { importToLibrary, bindDropzone, openGenerator, plain } from '../create.js';
import { autoTags } from '../generator.js';

export async function render(el, [docId]) {
  if (docId) return renderDoc(el, docId);
  const docs = await db.list('documents', { select: 'id,title,file_type,page_count,size_bytes,folder_id,created_at', order: 'created_at', desc: true });
  el.innerHTML = `<div>
    <div class="page-head"><div><h1>Library</h1><p class="sub">Your books, handouts and PDFs. Turn any of them — or just a few pages — into a quiz, an exam or flashcards.</p></div></div>
    <div class="dropzone" id="drop">${icon('upload')}<div><b>Drop PDFs or documents here</b> or tap to choose</div><div class="tiny">PDF · Word · PowerPoint · TXT · MD — up to 50 MB each</div></div>
    <div class="grid cards" style="margin-top:18px">
      ${docs.map((d) => `<div class="card click" data-id="${d.id}">
        <div class="row gap" style="align-items:flex-start"><span class="item-ico big">${icon('book')}</span>
          <div class="grow"><div class="item-title clamp2">${esc(d.title)}</div>
          <div class="item-meta">${d.page_count ? `<span>${d.page_count} pages</span>` : ''}<span>${fmtBytes(d.size_bytes || 0)}</span><span>${timeAgo(d.created_at)}</span></div></div></div>
        <div class="row gap" style="margin-top:14px">${d.folder_id && folderById(d.folder_id) ? `<span class="tag">${esc(folderById(d.folder_id).name)}</span>` : ''}<span class="grow"></span>
          <button class="btn sm" data-q="${d.id}">${icon('sparkle')} Quiz me</button></div>
      </div>`).join('')}
    </div>
    ${docs.length ? '' : `<div class="empty">${icon('book')}<h3>Your library is empty</h3><p class="small">Add a textbook chapter or reviewer and StudyDeck will read it for you.</p></div>`}
  </div>`;
  const root = el.firstElementChild;
  bindDropzone(root.querySelector('#drop'), async (fl) => { const made = await importToLibrary(fl); if (made.length === 1) go(`#/library/${made[0].id}`); else render(el, []); });
  root.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-q]');
    if (q) { e.stopPropagation(); const d = await db.get('documents', q.dataset.q); return openGenerator({ text: d.text_content, title: d.title, folder_id: d.folder_id, source: d.title, defaultKind: 'quiz' }); }
    const c = e.target.closest('[data-id]');
    if (c) go(`#/library/${c.dataset.id}`);
  });
}

async function renderDoc(el, id) {
  const d = await db.get('documents', id);
  if (!d) { el.innerHTML = `<div class="empty">${icon('book')}<h3>Not found</h3><a class="btn" href="#/library">Back to library</a></div>`; return; }
  setCrumb(d.title);
  const pages = d.text_content.split('\f');
  let page = 0;
  const [decks, quizzes] = await Promise.all([
    db.list('decks', { eq: { source_label: d.title } }),
    db.list('quizzes', { select: 'id,title,kind,questions,created_at,source_label', eq: { source_label: d.title } }),
  ]);
  const words = plain(d.text_content).split(/\s+/).filter(Boolean).length;
  el.innerHTML = `<div class="stack" style="gap:18px">
    <div class="row gap"><a class="icon-btn sm" href="#/library" aria-label="Back">${icon('back')}</a><span class="muted small">Library</span></div>
    <div class="card hl">
      <div class="row gap wrap" style="align-items:flex-start">
        <span class="item-ico big">${icon('book')}</span>
        <div class="grow" style="min-width:200px"><h2 style="font-size:22px">${esc(d.title)}</h2>
          <div class="item-meta">${d.page_count ? `<span>${d.page_count} pages</span>` : ''}<span>${words.toLocaleString()} words</span><span>${fmtBytes(d.size_bytes || 0)}</span><span>Added ${timeAgo(d.created_at)}</span></div></div>
      </div>
      ${words < 30 ? `<p class="small" style="margin-top:12px;color:#ffd38a">This file has no readable text — it's probably a scanned image. You can still open it, but questions can't be generated from it.</p>` : ''}
      <div class="row gap wrap" style="margin-top:16px">
        <button class="btn primary" data-k="quiz">${icon('quiz')} Make a quiz</button>
        <button class="btn" data-k="exam">${icon('clock')} Make an exam</button>
        <button class="btn" data-k="cards">${icon('cards')} Flashcards</button>
        <span class="grow"></span>
        <button class="btn ghost sm" id="open">${icon('eye')} Open original</button>
        <button class="btn ghost sm" id="to-note">${icon('note')} Copy to notes</button>
        <button class="btn ghost sm" id="ren">${icon('edit')} Rename</button>
        <button class="btn ghost sm" id="del">${icon('trash')} Delete</button>
      </div>
    </div>
    ${decks.length || quizzes.length ? `<div class="card"><div class="card-head"><h3>Made from this file</h3></div><div class="row gap wrap">
      ${decks.map((x) => `<a class="chip" href="#/decks/${x.id}">${icon('cards')} ${esc(x.title)}</a>`).join('')}
      ${quizzes.map((x) => `<a class="chip" href="#/quiz/${x.id}">${icon(x.kind === 'exam' ? 'clock' : 'quiz')} ${esc(x.title)} · ${x.questions.length}Q</a>`).join('')}</div></div>` : ''}
    <div class="card">
      <div class="card-head"><h3>Text</h3><span class="grow"></span>
        ${pages.length > 1 ? `<button class="icon-btn sm" id="prev" aria-label="Previous page">${icon('back')}</button><span class="small muted" id="pg"></span><button class="icon-btn sm" id="next" aria-label="Next page" style="transform:scaleX(-1)">${icon('back')}</button>` : ''}</div>
      <div class="prose" id="txt" style="white-space:pre-wrap;max-height:60vh;overflow-y:auto"></div>
    </div></div>`;
  const root = el.firstElementChild;
  const drawPage = () => {
    root.querySelector('#txt').textContent = pages[page].trim() || '(No text on this page)';
    const pg = root.querySelector('#pg'); if (pg) pg.textContent = `Page ${page + 1} / ${pages.length}`;
  };
  drawPage();
  root.querySelector('#prev')?.addEventListener('click', () => { if (page > 0) { page--; drawPage(); } });
  root.querySelector('#next')?.addEventListener('click', () => { if (page < pages.length - 1) { page++; drawPage(); } });
  root.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => openGenerator({ text: d.text_content, title: d.title, folder_id: d.folder_id, source: d.title, defaultKind: b.dataset.k })));
  root.querySelector('#open').addEventListener('click', async () => {
    const w = window.open('', '_blank');
    try {
      const blob = await files.getBlob(d.file_path);
      const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: d.file_type?.includes('/') ? d.file_type : 'application/pdf' }));
      if (w) w.location = url; else location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { w?.close(); toast('Could not open file: ' + e.message, 'err'); }
  });
  root.querySelector('#to-note').addEventListener('click', async () => {
    const content = plain(d.text_content).slice(0, 400000);
    const n = await db.insert('notes', { title: d.title, content, folder_id: d.folder_id, tags: autoTags(content), source_name: d.title });
    toast('Copied into your notes', 'ok'); go(`#/notes/${n.id}`);
  });
  root.querySelector('#ren').addEventListener('click', async () => {
    const t = await promptBox({ title: 'Rename', label: 'Title', value: d.title });
    if (t) { await db.update('documents', d.id, { title: t }); renderDoc(el, id); }
  });
  root.querySelector('#del').addEventListener('click', async () => {
    if (!await confirmBox({ title: 'Delete this file?', message: 'The file and its text are erased permanently. Flashcards and quizzes you made from it are kept.' })) return;
    await files.remove([d.file_path]).catch(() => {});
    await db.remove('documents', d.id);
    toast('Deleted'); go('#/library');
  });
}
