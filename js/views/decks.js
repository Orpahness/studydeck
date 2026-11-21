import { db } from '../store.js';
import { state, go, setCrumb, folderById, updateDueCount, focusId, setFocus, subjectSelectHtml, bindSubjectSelect } from '../app.js';
import { esc, icon, toast, confirmBox, promptBox, modal, pct, timeAgo, SWATCHES } from '../util.js';
import { isDue, isMastered, cardStatus } from '../srs.js';
import { openSourcePicker } from '../create.js';

export async function render(el, [deckId]) {
  if (deckId) return renderDeck(el, deckId);
  const [decks, cards] = await Promise.all([db.list('decks', { order: 'created_at', desc: true }), db.list('cards', { select: 'id,deck_id,due_at,interval_days,reps' })]);
  const fid = focusId();
  const shown = fid ? decks.filter((d) => d.folder_id === fid) : decks;
  const totalDue = cards.filter(isDue).length;
  el.innerHTML = `<div>
    <div class="page-head"><div><h1>Flashcards</h1><p class="sub">Cards come back right before you'd forget them. Rate yourself honestly and the schedule adapts.</p></div>
      <span class="grow"></span>
      <div class="row gap"><button class="btn" id="new-deck">${icon('plus')} Empty deck</button><button class="btn primary" id="gen">${icon('sparkle')} Generate</button></div></div>
    ${totalDue ? `<div class="card hl row gap wrap" style="margin-bottom:18px"><span class="item-ico big">${icon('flame')}</span><div class="grow"><h3>${totalDue} card${totalDue > 1 ? 's' : ''} due across all decks</h3><p class="small muted">A quick review now keeps your streak going.</p></div><a class="btn primary" href="#/study/all">${icon('play')} Review all</a></div>` : ''}
    ${state.folders.length ? `<div class="chips" style="margin-bottom:16px"><span class="small muted" style="align-self:center">Studying:</span><button class="chip ${!fid ? 'active' : ''}" data-f="">All</button>${state.folders.map((f) => `<button class="chip ${fid === f.id ? 'active' : ''}" data-f="${f.id}"><span class="swatch" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join('')}<button class="chip" data-edit-subjects>${icon('edit')} Edit</button></div>` : ''}
    <div class="grid cards">
      ${shown.map((d) => {
        const cs = cards.filter((c) => c.deck_id === d.id); const due = cs.filter(isDue).length; const m = pct(cs.filter(isMastered).length, cs.length);
        return `<div class="card click" data-id="${d.id}" style="border-top:3px solid ${esc(d.color)}">
          <div class="item-title clamp2">${esc(d.title)}</div>
          <div class="item-meta">${d.folder_id && folderById(d.folder_id) ? `<span>${esc(folderById(d.folder_id).name)}</span>` : ''}<span>${cs.length} cards</span>${due ? `<span class="when">${due} due</span>` : '<span>Up to date</span>'}</div>
          <div class="row gap" style="margin-top:14px"><div class="progress thin grow"><i style="width:${m}%"></i></div><span class="tiny muted">${m}% mastered</span></div>
          <div class="row gap" style="margin-top:14px"><button class="btn sm ${due ? 'primary' : ''}" data-study="${d.id}">${icon('play')} ${due ? 'Review' : 'Practice'}</button><button class="btn sm" data-learn="${d.id}">${icon('target')} Learn</button></div>
        </div>`; }).join('')}
    </div>
    ${shown.length ? '' : decks.length ? `<div class="empty small">No decks in this subject yet.</div>` : `<div class="empty">${icon('cards')}<h3>No flashcards yet</h3><p class="small">Generate them from your notes or a PDF, or build a deck by hand.</p></div>`}
  </div>`;
  const root = el.firstElementChild;
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-edit-subjects]')) { const { manageSubjects } = await import('../app.js'); return manageSubjects(() => render(el, [])); }
    const f = e.target.closest('[data-f]'); if (f) { await setFocus(f.dataset.f || null); return render(el, []); }
    const s = e.target.closest('[data-study]'); if (s) { e.stopPropagation(); return go(`#/study/${s.dataset.study}`); }
    const l = e.target.closest('[data-learn]'); if (l) { e.stopPropagation(); return go(`#/learn/deck/${l.dataset.learn}`); }
    const c = e.target.closest('[data-id]'); if (c) go(`#/decks/${c.dataset.id}`);
  });
  root.querySelector('#gen').addEventListener('click', () => openSourcePicker('cards'));
  root.querySelector('#new-deck').addEventListener('click', async () => {
    const t = await promptBox({ title: 'New deck', label: 'Deck name', confirmText: 'Create' });
    if (t) { const d = await db.insert('decks', { title: t, folder_id: focusId(), color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)] }); go(`#/decks/${d.id}`); }
  });
}

async function renderDeck(el, id) {
  const deck = await db.get('decks', id);
  if (!deck) { el.innerHTML = `<div class="empty"><h3>Deck not found</h3><a class="btn" href="#/decks">Back</a></div>`; return; }
  setCrumb(deck.title);
  const cards = await db.list('cards', { eq: { deck_id: id }, order: 'created_at' });
  const due = cards.filter(isDue).length, mastered = cards.filter(isMastered).length;
  const counts = { new: 0, learning: 0, mastered: 0 };
  cards.forEach((c) => counts[cardStatus(c)]++);
  el.innerHTML = `<div class="stack" style="gap:18px">
    <div class="row gap"><a class="icon-btn sm" href="#/decks" aria-label="Back">${icon('back')}</a><span class="muted small">Flashcards</span></div>
    <div class="card hl">
      <div class="row gap wrap"><span class="item-ico big">${icon('cards')}</span>
        <div class="grow" style="min-width:200px"><h2 style="font-size:22px">${esc(deck.title)}</h2>
        <div class="item-meta">${deck.source_label ? `<span>From ${esc(deck.source_label)}</span>` : ''}<span>${cards.length} cards</span><span>Created ${timeAgo(deck.created_at)}</span></div></div></div>
      <div class="row gap" style="margin-top:16px"><span class="small muted">Mastery</span><div class="progress grow" style="max-width:340px"><i style="width:${Math.max(3, pct(mastered, cards.length))}%"></i></div><span class="pct-badge">${pct(mastered, cards.length)}%</span></div>
      <div class="row gap wrap" style="margin-top:12px"><span class="tag plain">${counts.new} new</span><span class="tag plain">${counts.learning} learning</span><span class="tag">${counts.mastered} mastered</span></div>
      <div class="row gap wrap" style="margin-top:16px">
        <a class="btn primary" href="#/learn/deck/${id}" ${cards.length > 1 ? '' : 'style="pointer-events:none;opacity:.5"'}>${icon('target')} Learn</a>
        <a class="btn" href="#/study/${id}" data-sz ${cards.length ? '' : 'style="pointer-events:none;opacity:.5"'}>${icon('play')} ${due ? `Flip-review ${due} due` : 'Flip practice'}</a>
        <a class="btn" href="#/study/${id}?mode=cram" data-sz ${cards.length ? '' : 'style="pointer-events:none;opacity:.5"'}>${icon('shuffle')} Shuffle</a>
        <label class="small muted row gap">Per session <select class="input" id="sz" style="width:auto;height:36px;padding:0 30px 0 12px;border-radius:999px;font-size:13px">${[10, 20, 50, 100, 200].map((n) => `<option ${n === (Number(localStorage.getItem('studydeck.sessionSize')) || 50) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <span class="grow"></span>
        <label class="small muted row gap">Subject ${subjectSelectHtml(deck.folder_id, { id: 'dsub', cls: 'input" style="width:auto;height:36px;padding:0 30px 0 12px;border-radius:999px;font-size:13px' })}</label>
        <button class="btn ghost sm" id="ren">${icon('edit')} Rename</button>
        <button class="btn ghost sm" id="del">${icon('trash')} Delete</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Cards</h3><span class="grow"></span><button class="btn sm" id="add">${icon('plus')} Add card</button></div>
      <div id="cards">${cards.map((c) => cardRow(c)).join('') || '<p class="muted small">No cards yet — add one.</p>'}</div>
    </div></div>`;
  const root = el.firstElementChild;
  root.querySelector('#add').addEventListener('click', () => editCard(null));
  root.querySelector('#sz').addEventListener('change', (e) => localStorage.setItem('studydeck.sessionSize', e.target.value));
  bindSubjectSelect(root.querySelector('#dsub'), async (v) => { await db.update('decks', id, { folder_id: v }); toast('Subject updated', 'ok'); });
  root.querySelector('#cards').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-cid]'); if (!row) return;
    const c = cards.find((x) => x.id === row.dataset.cid);
    if (e.target.closest('[data-a=del]')) { await db.remove('cards', c.id); toast('Card deleted'); updateDueCount(); return renderDeck(el, id); }
    editCard(c);
  });
  root.querySelector('#ren').addEventListener('click', async () => {
    const t = await promptBox({ title: 'Rename deck', label: 'Name', value: deck.title });
    if (t) { await db.update('decks', id, { title: t }); renderDeck(el, id); }
  });
  root.querySelector('#del').addEventListener('click', async () => {
    if (await confirmBox({ title: 'Delete this deck?', message: `All ${cards.length} cards and their review history are erased permanently.` })) {
      await db.remove('decks', id); toast('Deck deleted'); updateDueCount(); go('#/decks');
    }
  });

  function editCard(c) {
    const m = modal({
      title: c ? 'Edit card' : 'New card',
      body: `<form id="cf"><label class="field"><span>Front (question / term)</span><textarea name="front" rows="3" required>${esc(c?.front || '')}</textarea></label>
        <label class="field"><span>Back (answer)</span><textarea name="back" rows="4" required>${esc(c?.back || '')}</textarea></label>
        <div class="row end gap">${c ? '' : '<label class="small muted row gap" style="margin-right:auto"><input type="checkbox" name="again" checked> Add another</label>'}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
      onClose: () => renderDeck(el, id),
    });
    m.el.querySelector('#cf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const row = { front: f.front.value.trim(), back: f.back.value.trim() };
      if (c) await db.update('cards', c.id, row); else await db.insert('cards', { ...row, deck_id: id });
      updateDueCount();
      if (!c && f.again?.checked) { f.reset(); f.again.checked = true; f.front.focus(); toast('Card added', 'ok'); } else m.close();
    });
  }
}

function cardRow(c) {
  const st = cardStatus(c);
  return `<div class="row gap" data-cid="${c.id}" style="padding:12px 0;border-bottom:1px solid var(--line);cursor:pointer;align-items:flex-start">
    <div class="grow" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 18px">
      <div style="font-weight:500;white-space:pre-line;overflow-wrap:anywhere">${esc(c.front)}</div>
      <div class="muted small" style="white-space:pre-line;overflow-wrap:anywhere">${esc(c.back)}</div></div>
    <span class="tag ${st === 'mastered' ? '' : 'plain'}">${st}</span>
    <button class="icon-btn sm ghost" data-a="del" aria-label="Delete card">${icon('trash')}</button></div>`;
}
