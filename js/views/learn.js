// Learn mode — retention-first, in small batches.
//
//  1. Items are split into batches of 5 or 10 so it never feels overwhelming.
//  2. Inside a batch, every item keeps coming back until you've answered it right
//     TWICE in separate passes. Miss it and it returns a few questions later.
//  3. After each batch there's a retention check: a few items from EARLIER batches
//     come back, even ones you got right, to make sure you still remember them.
//     Forget one and it goes back into learning.
//  4. When every batch is done, a final retention check runs through everything.
import { db } from '../store.js';
import { state, setCrumb, updateDueCount } from '../app.js';
import { esc, icon, shuffle, pct, toast } from '../util.js';
import { grade } from '../generator.js';
import { schedule } from '../srs.js';

const NEED = 2;           // correct answers (in separate passes) to learn an item
const REINSERT_AFTER = 3;  // a missed item returns after this many other questions

export async function render(el, [kind, arg = '']) {
  const [id] = arg.split('?');
  let src, items;
  if (kind === 'deck') {
    src = await db.get('decks', id);
    const cards = await db.list('cards', { eq: { deck_id: id }, order: 'created_at' });
    items = cards.map((c) => ({ key: c.id, card: c, prompt: c.front, answer: c.back, type: 'card' }));
  } else {
    src = await db.get('quizzes', id);
    items = (src?.questions || []).filter((q) => q.answer != null && q.answer !== '')
      .map((q) => ({ key: q.id, prompt: q.prompt, answer: String(q.answer), options: q.options, type: q.type, explanation: q.explanation }));
  }
  if (!src) { el.innerHTML = `<div class="empty"><h3>Not found</h3><a class="btn" href="#/">Home</a></div>`; return; }
  setCrumb(`Learn · ${src.title}`);
  const back = kind === 'deck' ? `#/decks/${id}` : `#/quiz/${id}`;
  const skipped = kind === 'quiz' ? (src.questions.length - items.length) : 0;
  if (items.length < 2) { el.innerHTML = `<div class="empty">${icon('cards')}<h3>Add at least 2 ${skipped ? 'answered ' : ''}items to use Learn</h3>${skipped ? '<p class="small">Some questions have no answer yet — set them in “Review & edit questions”.</p>' : ''}<a class="btn" href="${back}">Back</a></div>`; return; }

  const savedBatch = Number(localStorage.getItem('studydeck.batch')) || 5;
  const sizes = [...new Set([20, 50, 100].filter((s) => s < items.length).concat(items.length))];
  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><a class="icon-btn sm" href="${back}" aria-label="Back">${icon('back')}</a><span class="muted small">${esc(src.title)}</span></div>
    <div class="card hl" style="padding:28px">
      <span class="tag">${icon('target', 'tiny')} Learn mode</span>
      <h1 style="font-size:26px;margin-top:10px">${esc(src.title)}</h1>
      <ul class="small muted" style="margin:12px 0 0;padding-left:18px;line-height:1.8;max-width:560px">
        <li>You'll learn in small batches, then move on to the next.</li>
        <li>Every item comes back until you've got it right <b style="color:var(--text)">twice</b>. Missed ones come back sooner.</li>
        <li>Between batches, earlier items return for a <b style="color:var(--text)">retention check</b>, even ones you got right.</li>
      </ul>
      ${skipped ? `<p class="tiny" style="margin-top:10px;color:#ffd38a">${skipped} question${skipped > 1 ? 's' : ''} without an answer ${skipped > 1 ? 'are' : 'is'} left out.</p>` : ''}
      <div class="row gap wrap" style="margin-top:18px">
        <label class="field" style="margin:0;min-width:150px"><span>Batch size</span><select class="input" id="batch">${[5, 10].map((b) => `<option value="${b}" ${b === savedBatch ? 'selected' : ''}>${b} at a time</option>`).join('')}</select></label>
        <label class="field" style="margin:0;min-width:170px"><span>${kind === 'deck' ? 'Cards' : 'Questions'}</span><select class="input" id="size">${sizes.map((s) => `<option value="${s}" ${s === items.length ? 'selected' : ''}>${s === items.length ? `All ${s}` : `First ${s}`}</option>`).join('')}</select></label>
        <label class="small muted row gap" style="align-self:flex-end;padding-bottom:10px"><input type="checkbox" id="shuf"> Shuffle order</label>
      </div>
      <button class="btn primary" id="go" style="margin-top:18px">${icon('play')} Start learning</button>
    </div></div>`;
  el.querySelector('#go').addEventListener('click', () => {
    const batch = Number(el.querySelector('#batch').value);
    localStorage.setItem('studydeck.batch', String(batch));
    let chosen = items.slice(0, Number(el.querySelector('#size').value));
    if (el.querySelector('#shuf').checked) chosen = shuffle(chosen);
    run(el, src, kind, chosen, items, back, batch);
  });
}

function run(el, src, kind, items, pool, back, B) {
  const st = new Map(items.map((it) => [it.key, { streak: 0, missed: false, learned: false, seen: 0, passSeen: -1 }]));
  const S = (it) => st.get(it.key);
  const batches = [];
  for (let i = 0; i < items.length; i += B) batches.push(items.slice(i, i + B));
  const startedAt = Date.now();
  let answered = 0, correct = 0, batchNo = 0, passNo = 0;
  const backs = pool.map((p) => p.answer);
  let carry = []; // items forgotten in a retention check, re-learned with the next batch

  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><a class="icon-btn sm" href="${back}" aria-label="End session">${icon('x')}</a>
      <div class="grow"><div class="row between small muted"><span id="lphase"></span><span id="lcount"></span></div>
      <div class="learn-bar" id="lbar"><i class="m"></i><i class="l"></i></div></div></div>
    <div id="lbox"></div></div>`;
  const box = el.querySelector('#lbox');
  const phase = (t) => { el.querySelector('#lphase').textContent = t; };
  function bar() {
    const m = items.filter((it) => S(it).learned).length;
    const l = items.filter((it) => !S(it).learned && S(it).seen > 0).length;
    el.querySelector('#lbar .m').style.width = `${pct(m, items.length)}%`;
    el.querySelector('#lbar .l').style.width = `${pct(l, items.length)}%`;
    el.querySelector('#lcount').textContent = `${m} / ${items.length} learned`;
  }

  // ---------------------------------------------------------------- one question
  /** Ask `it`; resolves true/false. `recall` forces cards into recall (no choices). */
  function ask(it, { label = '', recall = false } = {}) {
    return new Promise((resolve) => {
      bar();
      const s = S(it);
      s.seen++;
      let mode = it.type;
      if (it.type === 'card') mode = !recall && s.streak === 0 && pool.length >= 3 ? 'mcq' : (it.answer.split(/\s+/).length > 6 ? 'self' : 'type');
      const opts = mode === 'mcq'
        ? (it.type === 'card' ? shuffle([it.answer, ...shuffle([...new Set(backs.filter((b) => b !== it.answer))]).slice(0, 3)]) : shuffle(it.options || []))
        : mode === 'tf' ? ['True', 'False'] : null;
      box.innerHTML = `<div class="card q-card">
        <div class="q-num">${label}</div>
        <div class="q-prompt">${esc(it.prompt)}</div>
        ${opts ? `<div class="opts">${opts.map((o, k) => `<button class="opt" data-o="${esc(o)}"><span class="key">${mode === 'tf' ? o[0] : k + 1}</span><span>${esc(o)}</span></button>`).join('')}</div>`
          : mode === 'self' ? `<div id="self"><button class="btn primary" style="width:100%" id="reveal">Show answer</button></div>`
          : mode === 'short' ? `<textarea class="textarea" id="ans" rows="3" placeholder="Answer in your own words"></textarea><button class="btn primary" style="width:100%;margin-top:10px" id="submit">Check</button>`
          : `<input class="input" id="ans" placeholder="Type the answer" autocomplete="off" autocapitalize="off"><div class="row gap" style="margin-top:10px"><button class="btn ghost sm" id="idk">Don't know</button><span class="grow"></span><button class="btn primary" id="submit">Check</button></div>`}
        <div id="fb"></div></div>`;
      const ans = box.querySelector('#ans');
      if (ans && matchMedia('(pointer:fine)').matches) ans.focus();
      let settled = false;
      const finish = (ok, { self = false, typed = '' } = {}) => {
        if (settled) return;
        settled = true;
        answered++; if (ok) correct++;
        db.insert('study_logs', { deck_id: it.card?.deck_id || null, card_id: it.card?.id || null, rating: ok ? 3 : 1 }).catch(() => {});
        if (self) return resolve(ok);
        const fb = box.querySelector('#fb');
        const reveal = !ok && it.type !== 'tf' && it.type !== 'mcq' && mode !== 'mcq' ? `<div style="margin-top:6px">Answer: <b style="white-space:pre-line">${esc(it.answer)}</b></div>` : '';
        fb.innerHTML = `<div class="feedback ${ok ? 'ok' : 'no'}"><b>${ok ? 'Correct!' : 'Not quite — this one will come back.'}</b>${reveal}
          ${!ok && typed ? '<button class="btn ghost sm" id="override" style="margin-top:8px">I was right — count it</button>' : ''}
          ${it.explanation && it.explanation !== it.answer ? `<div class="small muted" style="margin-top:6px">${esc(it.explanation)}</div>` : ''}</div>
          <div class="row end" style="margin-top:12px"><button class="btn primary" id="cont">Continue <span class="kbd" style="margin-left:6px">Enter</span></button></div>`;
        let gone = false;
        const go = (val) => { if (gone) return; gone = true; document.removeEventListener('keydown', onKey); resolve(val); };
        const onKey = (e) => { if (e.key === 'Enter' && !e.target.closest('textarea')) { e.preventDefault(); go(ok); } };
        setTimeout(() => document.addEventListener('keydown', onKey), 60);
        state.cleanup.push(() => document.removeEventListener('keydown', onKey));
        fb.querySelector('#cont').addEventListener('click', () => go(ok));
        fb.querySelector('#override')?.addEventListener('click', () => { correct++; go(true); });
        if (ok && !it.explanation) setTimeout(() => go(true), 850);
      };
      box.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
        const ok = b.dataset.o === it.answer;
        box.querySelectorAll('.opt').forEach((x) => { x.disabled = true; if (x.dataset.o === it.answer) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
        finish(ok);
      }));
      box.querySelector('#reveal')?.addEventListener('click', () => {
        box.querySelector('#self').innerHTML = `<div class="feedback"><div class="small muted">Answer</div><div style="white-space:pre-line;margin-top:4px">${esc(it.answer)}</div></div>
          <div class="row gap" style="margin-top:12px"><button class="btn danger grow" id="no">I didn't know it</button><button class="btn primary grow" id="yes">${icon('check')} I knew it</button></div>`;
        box.querySelector('#yes').addEventListener('click', () => finish(true, { self: true }));
        box.querySelector('#no').addEventListener('click', () => finish(false, { self: true }));
      });
      const submit = () => {
        if (mode === 'short') {
          box.querySelector('#submit').remove(); ans.disabled = true;
          box.querySelector('#fb').innerHTML = `<div class="feedback"><b>Model answer:</b> ${esc(it.answer)}<div class="row gap" style="margin-top:10px"><button class="btn danger sm grow" id="no">Missed it</button><button class="btn primary sm grow" id="yes">Got it</button></div></div>`;
          box.querySelector('#yes').addEventListener('click', () => finish(true, { self: true }));
          box.querySelector('#no').addEventListener('click', () => finish(false, { self: true }));
          return;
        }
        if (!ans.value.trim()) return;
        ans.disabled = true;
        box.querySelector('#submit')?.remove(); box.querySelector('#idk')?.remove();
        finish(grade({ type: 'fill', answer: it.answer }, ans.value) === true, { typed: ans.value });
      };
      box.querySelector('#submit')?.addEventListener('click', submit);
      ans?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && mode !== 'short') { e.preventDefault(); submit(); } });
      box.querySelector('#idk')?.addEventListener('click', () => { ans.disabled = true; box.querySelector('#submit')?.remove(); box.querySelector('#idk')?.remove(); finish(false); });
    });
  }

  function syncCard(it) {
    if (!it.card) return;
    const upd = schedule(it.card, S(it).missed ? 2 : 3);
    Object.assign(it.card, upd);
    db.update('cards', it.card.id, upd).catch(() => {});
  }

  // ---------------------------------------------------------------- learning a set until every item is learned
  async function learnSet(set, title) {
    while (set.some((it) => !S(it).learned)) {
      passNo++;
      // each pass: every unlearned item once (shuffled), misses re-inserted a few spots later
      const queue = shuffle(set.filter((it) => !S(it).learned)).map((it) => ({ it, again: false }));
      const misses = new Map();
      for (let i = 0; i < queue.length; i++) {
        const { it, again } = queue[i];
        const s = S(it);
        if (s.learned) continue;
        phase(title);
        const label = again ? '<span class="tag" style="background:rgba(248,113,133,.15);border-color:rgba(248,113,133,.4);color:#fecdd3">Try again</span>'
          : s.streak === 1 ? '<span class="tag">Once more to lock it in</span>' : `${title}`;
        const ok = await ask(it, { label });
        if (ok) {
          // only one streak point per pass, so "learned" always means two separate times
          if (s.passSeen !== passNo) { s.streak++; s.passSeen = passNo; }
          if (s.streak >= NEED) { s.learned = true; syncCard(it); }
        } else {
          s.streak = 0; s.missed = true; s.passSeen = -1; // getting it right later in this pass still counts once
          const n = (misses.get(it.key) || 0) + 1;
          misses.set(it.key, n);
          if (n < 4) queue.splice(Math.min(queue.length, i + 1 + REINSERT_AFTER), 0, { it, again: true });
        }
        bar();
      }
    }
  }

  // ---------------------------------------------------------------- retention check (asks items even if already learned)
  async function retentionCheck(set, title) {
    const forgotten = [];
    for (const [k, it] of set.entries()) {
      phase(`${title} · ${k + 1}/${set.length}`);
      const ok = await ask(it, { label: `<span class="tag" style="background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.4);color:#a7f3d0">${icon('target', 'tiny')} Retention check</span>`, recall: true });
      if (!ok) { const s = S(it); s.learned = false; s.streak = 0; s.missed = true; forgotten.push(it); }
      bar();
    }
    return forgotten;
  }

  function interstitial(html, btn) {
    return new Promise((resolve) => {
      box.innerHTML = `<div class="card">${html}<button class="btn primary" style="width:100%;margin-top:18px" id="nx">${btn}</button></div>`;
      const go = () => { document.removeEventListener('keydown', k); resolve(); };
      const k = (e) => { if (e.key === 'Enter') go(); };
      setTimeout(() => document.addEventListener('keydown', k), 80);
      state.cleanup.push(() => document.removeEventListener('keydown', k));
      box.querySelector('#nx').addEventListener('click', go);
    });
  }

  // ---------------------------------------------------------------- the session
  (async () => {
    const learnedBefore = [];
    for (batchNo = 1; batchNo <= batches.length; batchNo++) {
      const set = [...carry, ...batches[batchNo - 1]];
      carry = [];
      const title = `Batch ${batchNo} of ${batches.length}`;
      await interstitial(`<div class="card-head"><span class="item-ico">${icon('cards')}</span><div><h3>${title}</h3><div class="tiny muted">${set.length} item${set.length > 1 ? 's' : ''}${set.length > batches[batchNo - 1].length ? ` (incl. ${set.length - batches[batchNo - 1].length} to re-learn)` : ''}</div></div></div>
        <div class="stack" style="gap:6px;margin-top:6px">${set.map((it) => `<div class="small clamp2">• ${esc(it.prompt)}</div>`).join('')}</div>`, `${icon('play')} Start ${title.toLowerCase()}`);
      await learnSet(set, title);
      learnedBefore.push(...batches[batchNo - 1]);
      // retention check from earlier batches (not the one just finished)
      const earlier = learnedBefore.filter((it) => !set.includes(it));
      if (earlier.length) {
        const sample = shuffle(earlier).slice(0, B);
        await interstitial(`<div class="card-head"><span class="item-ico" style="color:var(--good)">${icon('check')}</span><div><h3>${title} learned!</h3><div class="tiny muted">${items.filter((it) => S(it).learned).length} of ${items.length} learned so far</div></div></div>
          <p class="small muted">Quick <b style="color:var(--text)">retention check</b>: ${sample.length} item${sample.length > 1 ? 's' : ''} from earlier batches, to make sure they stuck.</p>`, 'Start retention check');
        const forgotten = await retentionCheck(sample, 'Retention check');
        if (forgotten.length) {
          carry = forgotten;
          if (batchNo === batches.length) await learnSet(forgotten, 'Re-learning');
        }
      }
    }
    // final retention check over everything
    await interstitial(`<div class="card-head"><span class="item-ico" style="color:var(--good)">${icon('check')}</span><div><h3>All batches learned!</h3><div class="tiny muted">${answered} answers so far · ${pct(correct, answered)}% correct</div></div></div>
      <p class="small muted">Last step: a <b style="color:var(--text)">final retention check</b> of all ${items.length} items, in batches of ${B}. Anything you've forgotten gets re-learned.</p>`, 'Start final check');
    for (let i = 0; i < items.length; i += B) {
      const part = shuffle(items.slice(i, i + B));
      const forgotten = await retentionCheck(part, `Final check ${Math.floor(i / B) + 1}/${Math.ceil(items.length / B)}`);
      if (forgotten.length) await learnSet(forgotten, 'Re-learning');
    }
    finish();
  })();

  function finish() {
    bar(); phase('Done');
    const tricky = items.filter((it) => S(it).missed);
    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    box.innerHTML = `<div class="card hl" style="text-align:center;padding:32px 22px">
      <div class="item-ico big" style="margin:0 auto 14px">${icon('check')}</div>
      <h2>All ${items.length} learned!</h2>
      <p class="muted" style="margin-top:6px">${batches.length} batch${batches.length > 1 ? 'es' : ''} · ${answered} answers · ${pct(correct, answered)}% correct · ${mins} min</p>
      <p class="small muted" style="margin-top:6px">${items.length - tricky.length} never missed · ${tricky.length} needed extra practice</p>
      <div class="row gap wrap" style="justify-content:center;margin-top:18px">
        ${tricky.length ? `<button class="btn primary" id="tricky">${icon('shuffle')} Learn the ${tricky.length} tricky ones again</button>` : ''}
        <a class="btn" href="${back}">Done</a></div></div>
      ${tricky.length ? `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Needed extra practice</h3></div><div class="stack" style="gap:10px">${tricky.map((it) => `<div><div class="small" style="font-weight:500;white-space:pre-line">${esc(it.prompt)}</div><div class="small muted" style="white-space:pre-line">${esc(it.answer)}</div></div>`).join('')}</div></div>` : ''}`;
    box.querySelector('#tricky')?.addEventListener('click', () => run(el, src, kind, tricky, pool, back, B));
    if (kind === 'deck') updateDueCount();
    toast('Session saved to your progress', 'ok');
  }
}
