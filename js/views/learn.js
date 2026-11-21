// Learn mode (retention), in the spirit of Quizlet Learn:
// - Items come in rounds of 7.
// - Miss one and it comes back a few questions later in the same round — again and
//   again until you get it right.
// - Every item has to be answered correctly TWICE (in different rounds) before it
//   counts as learned, so the ones you got right also come back to make them stick.
// - Flashcards go multiple choice first, then you recall the answer yourself.
import { db } from '../store.js';
import { state, setCrumb, updateDueCount } from '../app.js';
import { esc, icon, shuffle, pct, toast } from '../util.js';
import { grade } from '../generator.js';
import { schedule } from '../srs.js';

const ROUND = 7;
const NEED = 2;          // correct answers needed per item
const REINSERT_AFTER = 3; // a missed item returns after this many other questions
export const MAX_ITEMS = 200;
const SIZES = [10, 20, 30, 50, 100, 200];

export async function render(el, [kind, arg = '']) {
  const [id, qs] = arg.split('?');
  const params = new URLSearchParams(qs || '');
  let src, items;
  if (kind === 'deck') {
    src = await db.get('decks', id);
    const cards = await db.list('cards', { eq: { deck_id: id } });
    // due & weakest first, so short sessions focus where it matters
    cards.sort((a, b) => (new Date(a.due_at) - new Date(b.due_at)) || ((a.interval_days || 0) - (b.interval_days || 0)));
    items = cards.map((c) => ({ key: c.id, card: c, prompt: c.front, answer: c.back, type: 'card' }));
  } else {
    src = await db.get('quizzes', id);
    items = shuffle((src?.questions || []).map((q) => ({ key: q.id, prompt: q.prompt, answer: String(q.answer), options: q.options, type: q.type, explanation: q.explanation })));
  }
  if (!src) { el.innerHTML = `<div class="empty"><h3>Not found</h3><a class="btn" href="#/">Home</a></div>`; return; }
  setCrumb(`Learn · ${src.title}`);
  if (items.length < 2) { el.innerHTML = `<div class="empty">${icon('cards')}<h3>Add at least 2 items to use Learn</h3><a class="btn" href="${kind === 'deck' ? `#/decks/${id}` : `#/quiz/${id}`}">Back</a></div>`; return; }
  const back = kind === 'deck' ? `#/decks/${id}` : `#/quiz/${id}`;
  const n = Number(params.get('n'));
  if (n) return run(el, src, kind, items.slice(0, Math.min(n, MAX_ITEMS)), items, back);

  // ---- setup screen
  const max = Math.min(items.length, MAX_ITEMS);
  const saved = Number(localStorage.getItem('studydeck.learnSize')) || 20;
  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><a class="icon-btn sm" href="${back}" aria-label="Back">${icon('back')}</a><span class="muted small">${esc(src.title)}</span></div>
    <div class="card hl" style="padding:28px">
      <span class="tag">${icon('target', 'tiny')} Learn mode</span>
      <h1 style="font-size:26px;margin-top:10px">Learn: ${esc(src.title)}</h1>
      <p class="muted small" style="margin-top:10px;max-width:520px">Miss something and it comes back a few questions later until you get it right. Every item has to be answered correctly <b style="color:var(--text)">twice</b>, so the ones you know come back too and actually stick.</p>
      <label class="field" style="margin-top:18px;max-width:280px"><span>How many ${kind === 'deck' ? 'cards' : 'questions'}? (${items.length} available${items.length > MAX_ITEMS ? `, max ${MAX_ITEMS}` : ''})</span>
        <select id="size">${[...new Set([...SIZES.filter((s) => s < max), max])].map((s) => `<option value="${s}" ${s === Math.min(saved, max) ? 'selected' : ''}>${s === max ? `All ${s}` : s}</option>`).join('')}</select></label>
      <button class="btn primary" id="go">${icon('play')} Start learning</button>
    </div></div>`;
  el.querySelector('#go').addEventListener('click', () => {
    const size = Number(el.querySelector('#size').value);
    localStorage.setItem('studydeck.learnSize', String(size));
    run(el, src, kind, items.slice(0, size), items, back);
  });
}

function run(el, src, kind, items, pool, back) {
  const st = new Map(items.map((it) => [it.key, { streak: 0, missed: false, seen: 0, lastRound: -1 }]));
  let roundNo = 0, round = [], pos = 0, roundLog = [];
  const startedAt = Date.now();
  let answeredTotal = 0, correctTotal = 0;
  const done = (it) => st.get(it.key).streak >= NEED;
  const backs = pool.map((p) => p.answer);

  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><a class="icon-btn sm" href="${back}" aria-label="End session">${icon('x')}</a>
      <div class="grow"><div class="row between small muted"><span>${esc(src.title)} · Learn</span><span id="lcount"></span></div>
      <div class="learn-bar" id="lbar"><i class="m"></i><i class="l"></i></div></div></div>
    <div id="lbox"></div></div>`;
  const box = el.querySelector('#lbox');

  function bar() {
    const m = items.filter(done).length;
    const l = items.filter((it) => !done(it) && st.get(it.key).seen > 0).length;
    el.querySelector('#lbar .m').style.width = `${pct(m, items.length)}%`;
    el.querySelector('#lbar .l').style.width = `${pct(l, items.length)}%`;
    el.querySelector('#lcount').textContent = `${m} / ${items.length} learned`;
  }

  function nextRound() {
    const left = items.filter((it) => !done(it));
    if (!left.length) return finish();
    roundNo++;
    // missed last round first, then in-progress, then new
    const score = (it) => { const s = st.get(it.key); return (s.missed && s.streak === 0 ? 0 : s.seen ? 1 : 2) + Math.random() * 0.5; };
    // don't ask an item you just got right again in the very next round unless that's all that's left
    let cand = left.filter((it) => !(st.get(it.key).streak > 0 && st.get(it.key).lastRound === roundNo - 1));
    if (cand.length < Math.min(ROUND, left.length)) cand = left;
    round = cand.sort((a, b) => score(a) - score(b)).slice(0, ROUND).map((it) => ({ it }));
    pos = 0; roundLog = [];
    ask();
  }

  function ask() {
    bar();
    if (pos >= round.length) return roundSummary();
    const { it } = round[pos];
    const s = st.get(it.key);
    s.seen++;
    s.lastRound = roundNo;
    // card: first correct is multiple choice, second is recall
    let mode = it.type;
    if (it.type === 'card') mode = s.streak === 0 && pool.length >= 3 ? 'mcq' : (it.answer.split(/\s+/).length > 6 ? 'self' : 'type');
    const opts = mode === 'mcq'
      ? (it.type === 'card' ? shuffle([it.answer, ...shuffle([...new Set(backs.filter((b) => b !== it.answer))]).slice(0, 3)]) : shuffle(it.options || []))
      : mode === 'tf' ? ['True', 'False'] : null;
    const again = s.missed && s.streak === 0 && s.seen > 1;
    box.innerHTML = `<div class="card q-card">
      <div class="q-num">${again ? `<span class="tag" style="background:rgba(248,113,133,.15);border-color:rgba(248,113,133,.4);color:#fecdd3">Let's try that again</span>` : s.streak === 1 ? '<span class="tag">Once more to lock it in</span>' : `Round ${roundNo}`}</div>
      <div class="q-prompt">${esc(it.prompt)}</div>
      ${opts ? `<div class="opts">${opts.map((o, k) => `<button class="opt" data-o="${esc(o)}"><span class="key">${mode === 'tf' ? o[0] : k + 1}</span><span>${esc(o)}</span></button>`).join('')}</div>`
        : mode === 'self' ? `<div id="self"><button class="btn primary" style="width:100%" id="reveal">Show answer</button></div>`
        : mode === 'short' ? `<textarea class="textarea" id="ans" rows="3" placeholder="Answer in your own words"></textarea><button class="btn primary" style="width:100%;margin-top:10px" id="submit">Check</button>`
        : `<input class="input" id="ans" placeholder="Type the answer" autocomplete="off" autocapitalize="off"><div class="row gap" style="margin-top:10px"><button class="btn ghost sm" id="idk">Don't know</button><span class="grow"></span><button class="btn primary" id="submit">Check</button></div>`}
      <div id="fb"></div></div>`;
    const ans = box.querySelector('#ans');
    if (ans && matchMedia('(pointer:fine)').matches) ans.focus();
    box.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      const ok = b.dataset.o === it.answer;
      box.querySelectorAll('.opt').forEach((x) => { x.disabled = true; if (x.dataset.o === it.answer) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
      result(ok);
    }));
    box.querySelector('#reveal')?.addEventListener('click', () => {
      box.querySelector('#self').innerHTML = `<div class="feedback"><div class="small muted">Answer</div><div style="white-space:pre-line;margin-top:4px">${esc(it.answer)}</div></div>
        <div class="row gap" style="margin-top:12px"><button class="btn danger grow" id="no">I didn't know it</button><button class="btn primary grow" id="yes">${icon('check')} I knew it</button></div>`;
      box.querySelector('#yes').addEventListener('click', () => result(true, true));
      box.querySelector('#no').addEventListener('click', () => result(false, true));
    });
    const submit = () => {
      if (mode === 'short') {
        box.querySelector('#submit').remove(); ans.disabled = true;
        box.querySelector('#fb').innerHTML = `<div class="feedback"><b>Model answer:</b> ${esc(it.answer)}<div class="row gap" style="margin-top:10px"><button class="btn danger sm grow" id="no">Missed it</button><button class="btn primary sm grow" id="yes">Got it</button></div></div>`;
        box.querySelector('#yes').addEventListener('click', () => result(true, true));
        box.querySelector('#no').addEventListener('click', () => result(false, true));
        return;
      }
      if (!ans.value.trim()) return;
      ans.disabled = true;
      box.querySelector('#submit')?.remove(); box.querySelector('#idk')?.remove();
      result(grade({ type: 'fill', answer: it.answer }, ans.value) === true, false, ans.value);
    };
    box.querySelector('#submit')?.addEventListener('click', submit);
    ans?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && mode !== 'short') { e.preventDefault(); submit(); } });
    box.querySelector('#idk')?.addEventListener('click', () => { ans.disabled = true; box.querySelector('#submit')?.remove(); box.querySelector('#idk')?.remove(); result(false); });
  }

  let locked = false;
  async function result(ok, selfGraded = false, typed = '') {
    if (locked) return;
    locked = true;
    const { it } = round[pos];
    const s = st.get(it.key);
    answeredTotal++; if (ok) correctTotal++;
    const prevStreak = s.streak, prevMissed = s.missed;
    if (ok) s.streak++; else { s.streak = 0; s.missed = true; }
    roundLog.push({ it, ok });
    // a miss comes back later in this same round, until it's right
    // (at most 3 times per round so a round can't drag on forever — after that it carries over)
    if (!ok && round.filter((r) => r.it === it).length < 3) round.splice(Math.min(round.length, pos + 1 + REINSERT_AFTER), 0, { it });
    db.insert('study_logs', { deck_id: it.card?.deck_id || null, card_id: it.card?.id || null, rating: ok ? 3 : 1 }).catch(() => {});
    const syncCard = () => {
      if (!done(it) || !it.card) return;
      // feed the result back into spaced repetition
      const upd = schedule(it.card, s.missed ? 2 : 3);
      Object.assign(it.card, upd);
      db.update('cards', it.card.id, upd).catch(() => {});
    };
    syncCard();
    const fb = box.querySelector('#fb');
    const showAnswer = !ok && !selfGraded && it.type !== 'tf' && it.type !== 'mcq' ? `<div style="margin-top:6px">Answer: <b style="white-space:pre-line">${esc(it.answer)}</b></div>` : '';
    fb.innerHTML = selfGraded ? '' : `<div class="feedback ${ok ? 'ok' : 'no'}"><b>${ok ? (done(it) ? 'Learned! ✓' : 'Correct!') : 'Not quite — you\'ll see this one again soon.'}</b>${showAnswer}
      ${!ok && typed ? `<button class="btn ghost sm" id="override" style="margin-top:8px">I was right — count it</button>` : ''}
      ${it.explanation && it.explanation !== it.answer ? `<div class="small muted" style="margin-top:6px">${esc(it.explanation)}</div>` : ''}</div>
      <div class="row end" style="margin-top:12px"><button class="btn primary" id="cont">Continue <span class="kbd" style="margin-left:6px">Enter</span></button></div>`;
    bar();
    let gone = false;
    const go = () => { if (gone) return; gone = true; document.removeEventListener('keydown', onEnter); locked = false; pos++; ask(); };
    const onEnter = (e) => { if (e.key === 'Enter' && !e.target.closest('textarea')) { e.preventDefault(); go(); } };
    if (selfGraded) return go();
    if (ok && !it.explanation) setTimeout(go, 900); // quick auto-advance when right
    setTimeout(() => document.addEventListener('keydown', onEnter), 50);
    state.cleanup.push(() => document.removeEventListener('keydown', onEnter));
    fb.querySelector('#cont').addEventListener('click', go);
    fb.querySelector('#override')?.addEventListener('click', () => {
      const k = round.findIndex((r, j) => j > pos && r.it === it);
      if (k > -1) round.splice(k, 1);
      s.streak = prevStreak + 1; s.missed = prevMissed; correctTotal++;
      roundLog[roundLog.length - 1].ok = true;
      syncCard();
      go();
    });
  }

  function roundSummary() {
    bar();
    const seen = [...new Map(roundLog.map((r) => [r.it.key, r.it])).values()];
    const left = items.filter((it) => !done(it)).length;
    if (!left) return finish();
    box.innerHTML = `<div class="card">
      <div class="card-head"><h3>Round ${roundNo} done</h3><span class="grow"></span><span class="tag">${items.filter(done).length}/${items.length} learned</span></div>
      <div class="stack" style="gap:8px">${seen.map((it) => {
        const s = st.get(it.key); const learned = done(it);
        return `<div class="row gap small"><span style="color:${learned ? 'var(--good)' : s.missed ? 'var(--bad)' : 'var(--accent-2)'}">${icon(learned ? 'check' : s.missed ? 'x' : 'clock', 'tiny')}</span><span class="grow clamp2">${esc(it.prompt)}</span><span class="tiny muted">${learned ? 'learned' : `${s.streak}/${NEED}`}</span></div>`;
      }).join('')}</div>
      <button class="btn primary" style="width:100%;margin-top:18px" id="nr">Continue · ${left} to go</button></div>`;
    box.querySelector('#nr').addEventListener('click', nextRound);
    const k = (e) => { if (e.key === 'Enter') { document.removeEventListener('keydown', k); nextRound(); } };
    setTimeout(() => document.addEventListener('keydown', k), 50);
    state.cleanup.push(() => document.removeEventListener('keydown', k));
  }

  function finish() {
    bar();
    const firstTry = items.filter((it) => !st.get(it.key).missed);
    const tricky = items.filter((it) => st.get(it.key).missed);
    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    box.innerHTML = `<div class="card hl" style="text-align:center;padding:32px 22px">
      <div class="item-ico big" style="margin:0 auto 14px">${icon('check')}</div>
      <h2>All ${items.length} learned!</h2>
      <p class="muted" style="margin-top:6px">${roundNo} rounds · ${answeredTotal} answers · ${pct(correctTotal, answeredTotal)}% correct · ${mins} min</p>
      <p class="small muted" style="margin-top:6px">${firstTry.length} never missed · ${tricky.length} needed extra practice</p>
      <div class="row gap wrap" style="justify-content:center;margin-top:18px">
        ${tricky.length ? `<button class="btn primary" id="tricky">${icon('shuffle')} Learn the ${tricky.length} tricky ones again</button>` : ''}
        <a class="btn" href="${back}">Done</a></div></div>
      ${tricky.length ? `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Needed extra practice</h3></div><div class="stack" style="gap:10px">${tricky.map((it) => `<div><div class="small" style="font-weight:500">${esc(it.prompt)}</div><div class="small muted" style="white-space:pre-line">${esc(it.answer)}</div></div>`).join('')}</div></div>` : ''}`;
    box.querySelector('#tricky')?.addEventListener('click', () => run(el, src, kind, tricky, pool, back));
    if (kind === 'deck') updateDueCount();
    toast('Session saved to your progress', 'ok');
  }

  nextRound();
}
