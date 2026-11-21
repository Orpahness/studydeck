import { db } from '../store.js';
import { state, go, setCrumb, folderById, refreshFolders, focusId, manageSubjects } from '../app.js';
import { esc, icon, timeAgo, debounce, toast, confirmBox, promptBox, modal, SWATCHES, $$ } from '../util.js';
import { renderMd } from '../md.js';
import { importAsNotes, bindDropzone, openGenerator } from '../create.js';
import { autoTags, detectSubject } from '../generator.js';

let folderFilter = '';
let query = '';
let mode = 'edit'; // edit | preview

export async function render(el, [noteId]) {
  const notes = await db.list('notes', { select: 'id,title,content,tags,folder_id,updated_at,pinned', order: 'updated_at', desc: true });
  if (!noteId && notes.length && matchMedia('(min-width: 761px)').matches) noteId = filtered(notes)[0]?.id;
  const note = noteId ? await db.get('notes', noteId) : null;
  if (note) setCrumb(note.title);

  el.innerHTML = `
  <div class="page-head"><div><h1>Notes</h1><p class="sub">Upload or write notes — they're saved as you type and filed by subject automatically.</p></div></div>
  <div class="notes-layout ${note ? 'editing' : ''}">
    <div class="notes-pane stack">
      <div class="dropzone" id="drop" style="padding:16px">${icon('upload')}<div class="small"><b>Upload notes</b> · PDF, Word, PPT, TXT, MD</div></div>
      <div class="row gap"><div class="search grow">${icon('search')}<input class="input" id="q" placeholder="Search notes" value="${esc(query)}"></div><button class="icon-btn" id="new" aria-label="New note" title="New note">${icon('plus')}</button></div>
      <div class="chips" id="folders">
        <button class="chip ${!folderFilter ? 'active' : ''}" data-f="">All</button>
        ${state.folders.map((f) => `<button class="chip ${folderFilter === f.id ? 'active' : ''}" data-f="${f.id}"><span class="swatch" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join('')}
        <button class="chip" id="manage" title="Rename or delete subjects">${icon('edit')} Edit subjects</button>
      </div>
      <div class="list notes-list" id="list"></div>
    </div>
    <div class="editor-pane">${note ? editorHtml(note) : `<div class="card empty">${icon('note')}<h3>${notes.length ? 'Pick a note' : 'No notes yet'}</h3><p class="small">Upload files or start writing. Each note can become flashcards or a quiz in one click.</p><button class="btn primary" id="new2">${icon('plus')} New note</button></div>`}</div>
  </div>`;

  const root = el.querySelector('.notes-layout');
  const list = el.querySelector('#list');
  const drawList = () => {
    const rows = filtered(notes);
    list.innerHTML = rows.length ? rows.map((n) => `
      <div class="item note-item ${n.id === noteId ? 'active' : ''}" data-id="${n.id}">
        <div class="grow">
          <div class="row gap"><div class="item-title grow clamp2">${n.pinned ? `<span style="color:var(--accent-2)">${icon('pin', 'tiny')}</span> ` : ''}${esc(n.title)}</div></div>
          <p class="small muted clamp2" style="margin-top:2px">${esc(n.content.replace(/[#*>`_]/g, '').slice(0, 160)) || '<i>Empty</i>'}</p>
          <div class="item-meta">${n.folder_id && folderById(n.folder_id) ? `<span><span class="chip-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(folderById(n.folder_id).color)}"></span> ${esc(folderById(n.folder_id).name)}</span>` : ''}<span>${timeAgo(n.updated_at)}</span></div>
        </div></div>`).join('') : `<div class="empty small">${query ? 'No matches' : 'Nothing here yet'}</div>`;
  };
  drawList();

  el.querySelector('#q').addEventListener('input', (e) => { query = e.target.value; drawList(); });
  list.addEventListener('click', (e) => { const it = e.target.closest('[data-id]'); if (it) go(`#/notes/${it.dataset.id}`); });
  el.querySelector('#folders').addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { folderFilter = f.dataset.f; $$('#folders .chip').forEach((c) => c.classList.toggle('active', c === f)); drawList(); }
  });
  el.querySelector('#manage').addEventListener('click', () => manageSubjects(() => render(el, [noteId])));
  const newNote = async () => { const n = await db.insert('notes', { title: 'Untitled note', content: '', folder_id: folderFilter || focusId() }); go(`#/notes/${n.id}`); };
  el.querySelector('#new').addEventListener('click', newNote);
  el.querySelector('#new2')?.addEventListener('click', newNote);
  bindDropzone(el.querySelector('#drop'), async (fl) => { const made = await importAsNotes(fl); if (made.length) go(`#/notes/${made[0].id}`); });

  if (note) bindEditor(el, note, notes, drawList);
}

function filtered(notes) {
  const q = query.trim().toLowerCase();
  return notes
    .filter((n) => !folderFilter || n.folder_id === folderFilter)
    .filter((n) => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || (n.tags || []).some((t) => t.includes(q)))
    .sort((a, b) => (b.pinned - a.pinned) || (a.updated_at < b.updated_at ? 1 : -1));
}

function editorHtml(n) {
  return `<div class="card editor">
    <div class="row gap wrap">
      <button class="icon-btn sm" id="back" aria-label="Back to notes">${icon('back')}</button>
      <div class="seg"><button data-m="edit" class="${mode === 'edit' ? 'on' : ''}">Edit</button><button data-m="preview" class="${mode === 'preview' ? 'on' : ''}">Read</button></div>
      <span class="save-state saved" id="ss">${icon('check')} Saved</span>
      <span class="grow"></span>
      <button class="btn primary sm" id="gen">${icon('sparkle')} <span>Study this</span></button>
      <button class="icon-btn sm" id="more" aria-label="More actions">${icon('dots')}</button>
    </div>
    <input class="title-in" id="title" value="${esc(n.title)}" aria-label="Title" placeholder="Title">
    <div class="row gap wrap">
      <select class="input" id="folder" style="width:auto;height:36px;padding:0 34px 0 12px;font-size:13px;border-radius:999px" aria-label="Subject">
        <option value="">No subject</option>${state.folders.map((f) => `<option value="${f.id}" ${f.id === n.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}<option value="__new">+ New subject…</option>
      </select>
      <div class="row gap wrap" id="tags">${(n.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      <button class="btn ghost sm" id="edit-tags">${icon('edit')} Tags</button>
    </div>
    <textarea class="textarea ${mode === 'preview' ? 'hidden' : ''}" id="body" placeholder="Start typing… Markdown works: # Heading, - bullet, **bold**.&#10;&#10;Tip: write definitions as “Term: meaning” and they become great flashcards.">${esc(n.content)}</textarea>
    <div class="prose ${mode === 'edit' ? 'hidden' : ''}" id="preview"></div>
    <div class="tiny dim">${n.source_name ? `Imported from ${esc(n.source_name)} · ` : ''}${n.content.split(/\s+/).filter(Boolean).length} words</div>
  </div>`;
}

function bindEditor(el, note, notes, drawList) {
  const $e = (s) => el.querySelector(s);
  const ss = $e('#ss'), body = $e('#body'), title = $e('#title'), preview = $e('#preview');
  const local = notes.find((x) => x.id === note.id) || note;
  const setState = (s) => { ss.className = `save-state ${s === 'saved' ? 'saved' : ''}`; ss.innerHTML = s === 'saved' ? `${icon('check')} Saved` : s === 'err' ? 'Not saved — retrying' : '<span class="spinner" style="width:12px;height:12px"></span> Saving…'; };
  const save = debounce(async () => {
    try {
      const patch = { title: title.value.trim() || 'Untitled note', content: body.value };
      if (!note.tags?.length && body.value.length > 200) patch.tags = autoTags(body.value);
      const saved = await db.update('notes', note.id, patch);
      Object.assign(note, saved); Object.assign(local, saved);
      if (patch.tags) $e('#tags').innerHTML = patch.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
      setState('saved'); drawList(); setCrumb(note.title);
    } catch (err) { setState('err'); console.error(err); if (document.body.contains(ss)) setTimeout(() => save(), 3000); }
  }, 600);
  const changed = () => { setState('saving'); save(); };
  body.addEventListener('input', changed);
  title.addEventListener('input', changed);
  // don't lose the last keystrokes when leaving the page
  const flush = () => { if (!ss.classList.contains('saved')) save.flush(); };
  window.addEventListener('beforeunload', flush);
  state.cleanup.push(() => { flush(); window.removeEventListener('beforeunload', flush); });

  const drawPreview = () => { preview.innerHTML = renderMd(body.value || '*Nothing written yet.*'); };
  if (mode === 'preview') drawPreview();
  el.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    mode = b.dataset.m;
    $$('.seg button', el).forEach((x) => x.classList.toggle('on', x === b));
    body.classList.toggle('hidden', mode !== 'edit'); preview.classList.toggle('hidden', mode !== 'preview');
    if (mode === 'preview') drawPreview();
  });
  $e('#back').addEventListener('click', () => go('#/notes'));
  $e('#gen').addEventListener('click', () => { save.flush(); openGenerator({ text: body.value, title: title.value, folder_id: note.folder_id, source: title.value }); });
  $e('#folder').addEventListener('change', async (e) => {
    let v = e.target.value;
    if (v === '__new') {
      const name = await promptBox({ title: 'New subject', label: 'Subject name', value: detectSubject(body.value) || '' });
      if (!name) { e.target.value = note.folder_id || ''; return; }
      const f = await db.insert('folders', { name, color: SWATCHES[state.folders.length % SWATCHES.length] });
      await refreshFolders(); v = f.id;
    }
    await db.update('notes', note.id, { folder_id: v || null });
    toast('Moved', 'ok');
    render(el, [note.id]);
  });
  $e('#edit-tags').addEventListener('click', async () => {
    const v = await promptBox({ title: 'Tags', label: 'Comma separated', value: (note.tags || []).join(', ') });
    if (v == null) return;
    const tags = [...new Set(v.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].slice(0, 12);
    await db.update('notes', note.id, { tags }); note.tags = tags; local.tags = tags;
    $e('#tags').innerHTML = tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
  });
  $e('#more').addEventListener('click', (e) => {
    e.stopPropagation();
    $$('.menu').forEach((m) => m.remove());
    const r = e.currentTarget.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'menu';
    m.style.top = `${r.bottom + 6 + scrollY}px`; m.style.right = `${Math.max(10, innerWidth - r.right)}px`;
    m.innerHTML = `<button data-a="pin">${icon('pin')} ${note.pinned ? 'Unpin' : 'Pin to top'}</button>
      <button data-a="pdf">${icon('download')} Export as PDF</button>
      <button data-a="docx">${icon('download')} Export as Word</button>
      <button data-a="dl">${icon('download')} Download (.md)</button>
      <button data-a="del" class="danger">${icon('trash')} Delete permanently</button>`;
    document.body.append(m);
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off, true); } };
    setTimeout(() => document.addEventListener('click', off, true));
    m.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return;
      m.remove();
      if (a === 'pin') { await db.update('notes', note.id, { pinned: !note.pinned }); render(el, [note.id]); }
      if (a === 'pdf' || a === 'docx') {
        const ex = await import('../export.js');
        try { await (a === 'pdf' ? ex.exportPdf : ex.exportDocx)(title.value, body.value); toast('Downloaded', 'ok'); } catch (err) { toast('Export failed: ' + err.message, 'err'); }
      }
      if (a === 'dl') {
        const blob = new Blob([`# ${title.value}\n\n${body.value}`], { type: 'text/markdown' });
        const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${title.value.replace(/[^\w\- ]+/g, '').trim() || 'note'}.md` });
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
      if (a === 'del' && await confirmBox({ title: 'Delete this note?', message: 'This can\'t be undone — deleted notes are not recoverable.' })) {
        save.cancel(); ss.classList.add('saved');
        await db.remove('notes', note.id); toast('Note deleted'); go('#/notes');
      }
    });
  });
}
