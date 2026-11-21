import { db } from '../store.js';
import { state, go, setCrumb, updateDueCount } from '../app.js';
import { esc, icon, shuffle, pct, toast } from '../util.js';
import { schedule, preview, isDue } from '../srs.js';

export async function render(el, [arg = 'all']) {
  const [deckId, qs] = arg.split('?');
  const params = new URLSearchParams(qs || '');
  const cram = params.get('mode') === 'cram';
  const size = Math.min(200, Number(params.get('n')) || Number(localStorage.getItem('studydeck.sessionSize')) || 50);
  const deck = deckId !== 'all' ? await db.get('decks', deckId) : null;
  setCrumb(deck ? deck.title : 'Review');
  const all = deck ? await db.list('cards', { eq: { deck_id: deckId } }) : await db.list('cards');
  let practice = cram;
  let queue = (cram ? shuffle(all) : shuffle(all.filter(isDue))).slice(0, size);
  if (!queue.length && all.length) { practice = true; queue = shuffle(all).slice(0, size); }
  if (!queue.length) {
    el.innerHTML = `<div class="empty">${icon('check')}<h3>Nothing to review</h3><p class="small">Add or generate some flashcards first.</p><a class="btn" href="#/decks">Go to flashcards</a></div>`;
    return;
  }
  const total = queue.length;
  let done = 0, flipped = false;
  const tally = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const startedAt = Date.now();

  el.innerHTML = `<div class="study-wrap">
    <div class="row gap"><a class="icon-btn sm" href="${deck ? `#/decks/${deck.id}` : '#/decks'}" aria-label="End session">${icon('x')}</a>
      <div class="grow"><div class="small muted">${esc(deck?.title || 'All decks')}${practice ? ' · practice (schedule unchanged)' : ''}</div><div class="bar-progress" style="margin-top:6px"><i id="bar" style="width:0%"></i></div></div>
      <span class="small muted" id="count"></span></div>
    <div id="stage"></div></div>`;
  const stage = el.querySelector('#stage');

  function draw() {
    el.querySelector('#bar').style.width = `${pct(done, total)}%`;
    el.querySelector('#count').textContent = `${Math.min(done + 1, total)} / ${total}`;
    const c = queue[0];
    if (!c) return finish();
    flipped = false;
    stage.innerHTML = `
      <div class="flip" id="flip" tabindex="0" role="button" aria-label="Flip card">
        <div class="flip-inner">
          <div class="face front"><span class="lbl">Question</span><div class="txt">${esc(c.front)}</div><div class="tiny dim" style="position:absolute;bottom:16px">Tap or press <span class="kbd">Space</span> to reveal</div></div>
          <div class="face back"><span class="lbl">Answer</span><div class="txt">${esc(c.back)}</div></div>
        </div></div>
      <div id="rate-wrap" style="margin-top:18px">
        <button class="btn primary" style="width:100%;height:54px" id="show">Show answer</button>
      </div>`;
    stage.querySelector('#flip').addEventListener('click', flip);
    stage.querySelector('#show').addEventListener('click', flip);
  }

  function flip() {
    const c = queue[0];
    if (!c || !stage.querySelector('#flip')) return;
    flipped = !flipped;
    stage.querySelector('#flip').classList.toggle('flipped', flipped);
    if (flipped && !stage.querySelector('.rate')) {
      stage.querySelector('#rate-wrap').innerHTML = `<div class="rate">
        <button class="again" data-r="1">Again<small>${practice ? '1' : preview(c, 1)}</small></button>
        <button class="hard" data-r="2">Hard<small>${practice ? '2' : preview(c, 2)}</small></button>
        <button class="good" data-r="3">Good<small>${practice ? '3' : preview(c, 3)}</small></button>
        <button class="easy" data-r="4">Easy<small>${practice ? '4' : preview(c, 4)}</small></button></div>
        <p class="tiny dim" style="text-align:center;margin-top:10px">Keys: <span class="kbd">1</span> <span class="kbd">2</span> <span class="kbd">3</span> <span class="kbd">4</span></p>`;
      stage.querySelector('.rate').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) rate(Number(b.dataset.r)); });
    }
  }

  let busy = false;
  async function rate(r) {
    if (busy || !flipped || !queue.length) return;
    busy = true;
    const c = queue.shift();
    tally[r]++;
    try {
      if (!practice) { const upd = schedule(c, r); Object.assign(c, upd); await db.update('cards', c.id, upd); }
      await db.insert('study_logs', { deck_id: c.deck_id, card_id: c.id, rating: r });
    } catch (e) { toast('Couldn\'t save that review: ' + e.message, 'err'); }
    if (r === 1) queue.push(c); else done++;
    busy = false;
    draw();
  }

  function finish() {
    el.querySelector('#bar').style.width = '100%';
    el.querySelector('#count').textContent = `${total} / ${total}`;
    const reviews = tally[1] + tally[2] + tally[3] + tally[4];
    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    stage.innerHTML = `<div class="card hl" style="text-align:center;padding:36px 22px">
      <div class="item-ico big" style="margin:0 auto 14px">${icon('check')}</div>
      <h2>Session complete</h2>
      <p class="muted" style="margin-top:6px">${total} cards · ${reviews} reviews · ${mins} min</p>
      <div class="row gap wrap" style="justify-content:center;margin-top:16px">
        <span class="tag plain">Again ${tally[1]}</span><span class="tag plain">Hard ${tally[2]}</span><span class="tag">Good ${tally[3]}</span><span class="tag">Easy ${tally[4]}</span></div>
      <p class="small muted" style="margin-top:14px">Recall rate this session: <b style="color:var(--text)">${pct(tally[3] + tally[4], reviews)}%</b></p>
      <div class="row gap wrap" style="justify-content:center;margin-top:20px">
        <a class="btn" href="${deck ? `#/decks/${deck.id}` : '#/decks'}">Done</a>
        <a class="btn primary" href="#/">${icon('home')} Dashboard</a></div></div>`;
    updateDueCount();
  }

  const onKey = (e) => {
    if (e.target.closest('input,textarea')) return;
    if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); flip(); }
    if (['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key));
  };
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey));
  draw();
}
