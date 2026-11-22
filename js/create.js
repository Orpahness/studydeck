// Shared flows: importing files as notes / library books, and the
// "Generate flashcards / quiz / exam" dialog used all over the app.
import { db, files, auth } from './store.js';
import { extractText, ACCEPT } from './extract.js';
import { makeFlashcards, makeQuestions, autoTitle, autoTags, detectSubject } from './generator.js';
import { extractExistingQuestions, applyAnswerKey } from './importq.js';
import { state, ensureFolder, go, updateDueCount, focusId, subjectSelectHtml, bindSubjectSelect } from './app.js';
import { esc, icon, modal, toast, fmtBytes } from './util.js';

export { ACCEPT };
export const plain = (t) => (t || '').replace(/\f/g, '\n\n');

export function pickFiles({ multiple = true, accept = ACCEPT } = {}) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => resolve([...i.files]);
    i.click();
  });
}

export function bindDropzone(el, onFiles) {
  el.addEventListener('click', async () => { const f = await pickFiles(); if (f.length) onFiles(f); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
  el.setAttribute('role', 'button'); el.tabIndex = 0;
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
}

function progressModal(title) {
  const m = modal({ title, body: `<div class="stack"><p class="small muted" id="pm-txt">Starting…</p><div class="bar-progress"><i id="pm-bar" style="width:0%"></i></div></div>` });
  return {
    set(txt, frac) { m.el.querySelector('#pm-txt').textContent = txt; if (frac != null) m.el.querySelector('#pm-bar').style.width = `${Math.round(frac * 100)}%`; },
    close: m.close,
  };
}

/** Upload files as editable notes: text extracted, titled, tagged and filed by subject automatically. */
export async function importAsNotes(fileList) {
  const pm = progressModal('Importing notes');
  const made = [];
  for (const [i, f] of fileList.entries()) {
    try {
      pm.set(`Reading ${f.name}…`, i / fileList.length);
      const { text } = await extractText(f, (p) => pm.set(`Reading ${f.name}… ${Math.round(p * 100)}%`, (i + p) / fileList.length));
      const content = plain(text);
      if (!content.trim()) { toast(`${f.name}: no readable text (scanned image?)`, 'err'); continue; }
      const folder_id = focusId() || await ensureFolder(detectSubject(content));
      made.push(await db.insert('notes', {
        title: autoTitle(content, f.name.replace(/\.[^.]+$/, '')), content, tags: autoTags(content), folder_id, source_name: f.name,
      }));
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  pm.close();
  if (made.length) toast(`Saved ${made.length} note${made.length > 1 ? 's' : ''}${focusId() ? '' : ' and sorted by subject'}`, 'ok');
  return made;
}

/** Upload books / PDFs to the library: keeps the original file + extracted text. */
export async function importToLibrary(fileList) {
  const pm = progressModal('Adding to library');
  const made = [];
  for (const [i, f] of fileList.entries()) {
    try {
      if (f.size > 50 * 1024 * 1024) { toast(`${f.name} is over 50 MB`, 'err'); continue; }
      pm.set(`Reading ${f.name} (${fmtBytes(f.size)})…`, i / fileList.length);
      const { text, pages } = await extractText(f, (p) => pm.set(`Reading ${f.name}… page ${Math.round(p * 100)}%`, (i + p * 0.8) / fileList.length));
      pm.set(`Saving ${f.name}…`, (i + 0.9) / fileList.length);
      const path = files.path(f.name);
      await files.upload(path, f);
      const folder_id = focusId() || await ensureFolder(detectSubject(plain(text)));
      made.push(await db.insert('documents', {
        title: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), file_path: path, file_type: f.type || f.name.split('.').pop(),
        size_bytes: f.size, page_count: pages, text_content: text, folder_id,
      }));
      if (!plain(text).trim()) toast(`${f.name}: saved, but it has no text layer (scanned). Questions can't be generated from it.`, 'err');
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  pm.close();
  if (made.length) toast(`Added ${made.length} file${made.length > 1 ? 's' : ''} to your library`, 'ok');
  return made;
}

export const MAX_ITEMS = 200;

async function aiCall(text, kind, count, types) {
  const token = await auth.accessToken();
  const r = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ text, kind, count, types }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `AI request failed (${r.status})`);
  return j;
}
/** Big requests are split into batches of up to 40, each from its own slice of the text. */
async function aiGenerate(text, kind, count, types, onProgress = () => {}) {
  const batches = Math.ceil(count / 40);
  const key = kind === 'cards' ? 'cards' : 'questions';
  const out = [];
  const slice = Math.ceil(text.length / batches);
  for (let b = 0; b < batches; b++) {
    onProgress(b, batches);
    const part = batches === 1 ? text : text.slice(Math.max(0, b * slice - 500), (b + 1) * slice);
    const j = await aiCall(part, kind, Math.min(40, count - out.length), types);
    out.push(...(j[key] || []));
  }
  return { [key]: out.slice(0, count) };
}

/**
 * The generate dialog.
 * @param {{text:string, title:string, folder_id?:string, source?:string, pages?:number, defaultKind?:'cards'|'quiz'|'exam'}} src
 */
export function openGenerator(src) {
  const rawText = src.text || '';
  if (plain(rawText).trim().length < 60) { toast('Add more text first — there isn\'t enough to build questions from.', 'err'); return; }
  const found = extractExistingQuestions(rawText);
  const kind0 = src.defaultKind || (found ? 'quiz' : 'cards');
  const pageCount = (rawText.match(/\f/g) || []).length + 1;
  const m = modal({
    title: 'Create study material', wide: true,
    body: `<form id="gen">
      <p class="small muted" style="margin-bottom:14px">From: <b style="color:var(--text)">${esc(src.title)}</b></p>
      ${found ? `<div class="found-box">
        <div class="row gap">${icon('check')}<b>This file already has ${found.total} questions${found.missing === found.total ? ' (no answer key found)' : found.missing ? ` (${found.total - found.missing} with answers)` : ' with answers'}</b></div>
        <div class="check-row" style="margin-top:10px">
          <label><input type="radio" name="source" value="file" checked> Use the file's questions exactly as written</label>
          <label><input type="radio" name="source" value="gen"> Make new questions from the text</label>
        </div>
        ${found.missing ? `<div class="field file-only" style="margin:12px 0 0"><span>${found.missing === found.total ? 'Type the answer key' : `${found.missing} question${found.missing > 1 ? 's have' : ' has'} no answer — type them`} here if you have it (optional, you can also do it later):</span>
          <textarea name="akey" rows="2" placeholder="e.g. 1.B 2.C 3.A 4.True …  or just  BCATD…"></textarea></div>` : ''}
      </div>` : ''}
      <div class="radio-cards">
        <label><input type="radio" name="kind" value="cards" ${kind0 === 'cards' ? 'checked' : ''}>${icon('cards')}Flashcards<small>Flip cards with spaced review</small></label>
        <label><input type="radio" name="kind" value="quiz" ${kind0 === 'quiz' ? 'checked' : ''}>${icon('quiz')}Quiz<small>Instant feedback per question</small></label>
        <label><input type="radio" name="kind" value="exam" ${kind0 === 'exam' ? 'checked' : ''}>${icon('clock')}Exam<small>Timed, results at the end</small></label>
      </div>
      <div class="row gap wrap">
        <label class="field grow" style="min-width:200px"><span>Title</span><input name="title" value="${esc(src.title)}" required></label>
        <label class="field" style="min-width:180px"><span>Subject</span>${subjectSelectHtml(src.folder_id || focusId(), { id: 'gsubject' })}</label>
      </div>
      <div class="row gap wrap">
        <label class="field grow"><span>How many? (up to ${MAX_ITEMS})</span><input name="count" type="number" min="3" max="${MAX_ITEMS}" value="${kind0 === 'exam' ? 30 : 15}"></label>
        <label class="field grow q-only"><span>Time limit (minutes, exam)</span><input name="time" type="number" min="0" max="300" value="30"></label>
        ${pageCount > 1 ? `<label class="field grow"><span>Pages (of ${pageCount})</span><input name="pages" placeholder="e.g. 1-20 (blank = all)"></label>` : ''}
      </div>
      <div class="field q-only"><span>Question types</span><div class="check-row">
        <label><input type="checkbox" name="types" value="mcq" checked> Multiple choice</label>
        <label><input type="checkbox" name="types" value="tf" checked> True / False</label>
        <label><input type="checkbox" name="types" value="fill" checked> Fill in the blank</label>
        <label><input type="checkbox" name="types" value="short"> Short answer (self-checked)</label>
      </div></div>
      ${state.aiEnabled ? `<div class="field"><span>Generator</span><div class="check-row">
        <label><input type="radio" name="engine" value="local" checked> Built-in (instant, private)</label>
        <label><input type="radio" name="engine" value="ai"> AI (smarter, sends this text to the AI service)</label></div></div>` : ''}
      <div class="row end gap" style="margin-top:6px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="gen-go">${icon('sparkle')} Generate</button></div>
    </form>`,
  });
  const form = m.el.querySelector('#gen');
  bindSubjectSelect(form.querySelector('#gsubject'));
  const sync = () => {
    const k = form.kind.value;
    const fromFile = found && form.source?.value === 'file';
    m.el.querySelectorAll('.file-only').forEach((el) => { el.style.display = fromFile ? '' : 'none'; });
    m.el.querySelectorAll('.q-only').forEach((el) => { el.style.display = k === 'cards' || fromFile ? 'none' : ''; });
    form.time.closest('.field').style.display = k === 'exam' ? '' : 'none';
    form.count.closest('.field').style.display = fromFile ? 'none' : '';
    if (form.pages) form.pages.closest('.field').style.display = fromFile ? 'none' : '';
    const eng = form.querySelector('[name=engine]')?.closest('.field'); if (eng) eng.style.display = fromFile ? 'none' : '';
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') form.count.value = e.target.value === 'exam' ? 30 : 15;
    sync();
  });
  sync();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = m.el.querySelector('#gen-go');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
    try {
      const kind = form.kind.value;
      const count = Math.max(3, Math.min(MAX_ITEMS, Number(form.count.value) || 15));
      const folder_id = form.querySelector('#gsubject').value || null;
      const types = [...form.querySelectorAll('[name=types]:checked')].map((x) => x.value);
      if (kind !== 'cards' && !types.length) throw new Error('Pick at least one question type');
      let text = rawText;
      const pr = form.pages?.value.trim();
      if (pr) {
        const [a, b] = pr.split(/\s*[-–]\s*/).map(Number);
        const pages = rawText.split('\f');
        text = pages.slice(Math.max(0, (a || 1) - 1), Math.min(pages.length, b || a || pages.length)).join('\n\n');
      }
      text = plain(text);
      const useAI = form.engine?.value === 'ai';
      const fromFile = found && form.source?.value === 'file';
      const title = form.title.value.trim() || src.title;
      if (kind === 'cards') {
        const prog = (b, n) => { if (n > 1) btn.innerHTML = `<span class="spinner"></span> Generating… ${b + 1}/${n}`; };
        if (fromFile && form.akey?.value.trim()) applyAnswerKey(found.questions, form.akey.value);
        let cards = fromFile
          ? found.questions.filter((q) => q.answer != null).map((q) => ({ front: q.type === 'mcq' ? `${q.prompt}\n\n${q.options.map((o, i) => `${'abcdefgh'[i]}. ${o}`).join('\n')}` : q.prompt, back: q.answer }))
          : useAI ? (await aiGenerate(text, 'cards', count, null, prog)).cards : makeFlashcards(text, { max: count });
        cards = (cards || []).filter((c) => c.front && c.back);
        if (!cards.length) throw new Error('Couldn\'t find clear facts or definitions. Try a different section, or add cards by hand.');
        const deck = await db.insert('decks', { title, folder_id, source_label: src.source || src.title });
        await db.insert('cards', cards.map((c) => ({ deck_id: deck.id, front: String(c.front).slice(0, 2000), back: String(c.back).slice(0, 4000) })));
        m.close(); toast(cards.length < count ? `Made ${cards.length} flashcards — that's everything clear enough in this material` : `Made ${cards.length} flashcards`, 'ok'); updateDueCount();
        go(`#/decks/${deck.id}`);
      } else {
        const prog = (b, n) => { if (n > 1) btn.innerHTML = `<span class="spinner"></span> Generating… ${b + 1}/${n}`; };
        if (fromFile && form.akey?.value.trim()) applyAnswerKey(found.questions, form.akey.value);
        let qs = fromFile ? found.questions : useAI ? (await aiGenerate(text, kind, count, types, prog)).questions : makeQuestions(text, { count, types });
        qs = (qs || []).filter((q) => q.prompt && (fromFile || q.answer != null)).map((q, i) => ({ id: q.id || `q${Date.now().toString(36)}${i}`, ...q, answer: q.answer == null ? null : String(q.answer) }));
        if (qs.length < 3) throw new Error('Not enough material for questions here. Try more text or other question types.');
        const quiz = await db.insert('quizzes', { title, kind, questions: qs, time_limit_min: kind === 'exam' ? Number(form.time.value) || null : null, folder_id, source_label: src.source || src.title });
        m.close(); toast(fromFile ? `Imported all ${qs.length} questions from the file` : `${kind === 'exam' ? 'Exam' : 'Quiz'} ready — ${qs.length} questions${qs.length < count ? ' (all this material supports)' : ''}`, 'ok');
        go(`#/quiz/${quiz.id}`);
      }
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.innerHTML = `${icon('sparkle')} Generate`;
    }
  });
}

/** Dialog to choose what to generate from: a note, a library book, a new upload, or pasted text. */
export async function openSourcePicker(defaultKind = 'cards') {
  const [notes, docs] = await Promise.all([db.list('notes', { select: 'id,title,folder_id', order: 'updated_at', desc: true }), db.list('documents', { select: 'id,title,folder_id,page_count', order: 'created_at', desc: true })]);
  const m = modal({
    title: 'What do you want to study?', wide: true,
    body: `<div class="stack">
      <div class="dropzone" id="sp-drop">${icon('upload')}<div><b>Upload a file</b> — PDF, Word, PowerPoint or text</div><div class="tiny">It's saved to your library first</div></div>
      ${docs.length || notes.length ? `<label class="field"><span>…or pick something you already have</span><select id="sp-sel"><option value="">Choose a note or book</option>
        ${docs.length ? `<optgroup label="Library">${docs.map((d) => `<option value="d:${d.id}">${esc(d.title)}${d.page_count ? ` (${d.page_count} pages)` : ''}</option>`).join('')}</optgroup>` : ''}
        ${notes.length ? `<optgroup label="Notes">${notes.map((n) => `<option value="n:${n.id}">${esc(n.title)}</option>`).join('')}</optgroup>` : ''}
      </select></label>` : ''}
      <label class="field"><span>…or paste text</span><textarea class="textarea" id="sp-text" rows="5" placeholder="Paste a chapter, lecture notes, a glossary…"></textarea></label>
      <div class="row end gap"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="sp-go">Continue</button></div></div>`,
  });
  const next = (src) => { m.close(); setTimeout(() => openGenerator({ ...src, defaultKind }), 180); };
  bindDropzone(m.el.querySelector('#sp-drop'), async (fl) => {
    m.close();
    const made = await importToLibrary(fl.slice(0, 1));
    if (made[0]) openGenerator({ text: made[0].text_content, title: made[0].title, folder_id: made[0].folder_id, source: made[0].title, defaultKind });
  });
  m.el.querySelector('#sp-go').addEventListener('click', async () => {
    const sel = m.el.querySelector('#sp-sel')?.value;
    const pasted = m.el.querySelector('#sp-text').value.trim();
    if (sel) {
      const [t, id] = sel.split(':');
      const row = await db.get(t === 'd' ? 'documents' : 'notes', id);
      return next({ text: t === 'd' ? row.text_content : row.content, title: row.title, folder_id: row.folder_id, source: row.title });
    }
    if (pasted) return next({ text: pasted, title: autoTitle(pasted, 'Pasted text'), source: 'Pasted text' });
    toast('Upload, pick, or paste something first', 'err');
  });
}
