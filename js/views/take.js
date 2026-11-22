import { db } from '../store.js';
import { state, go, setCrumb, subjectSelectHtml, bindSubjectSelect } from '../app.js';
import { esc, icon, pct, shuffle, timeAgo, toast, modal, confirmBox } from '../util.js';
import { grade } from '../generator.js';
import { applyAnswerKey } from '../importq.js';
import { ring } from '../chart.js';

const TYPE_LABEL = { mcq: 'Multiple choice', tf: 'True or false', fill: 'Fill in the blank', short: 'Short answer' };

export async function render(el, [id]) {
  const quiz = await db.get('quizzes', id);
  if (!quiz) { el.innerHTML = `<div class="empty"><h3>Quiz not found</h3><a class="btn" href="#/quizzes">Back</a></div>`; return; }
  setCrumb(quiz.title);
  intro(el, quiz);
}

async function intro(el, quiz) {
  const attempts = await db.list('quiz_attempts', { eq: { quiz_id: quiz.id }, order: 'created_at', desc: true });
  const exam = quiz.kind === 'exam';
  const answerable = quiz.questions.filter((q) => q.answer != null && q.answer !== '');
  const noAnswer = quiz.questions.length - answerable.length;
  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><a class="icon-btn sm" href="#/quizzes" aria-label="Back">${icon('back')}</a><span class="muted small">Quizzes & exams</span></div>
    <div class="card hl" style="padding:28px">
      <span class="tag">${exam ? 'Exam' : 'Quiz'}</span>
      <h1 style="font-size:28px;margin-top:10px">${esc(quiz.title)}</h1>
      <div class="item-meta" style="font-size:13px"><span>${quiz.questions.length} questions</span>${exam && quiz.time_limit_min ? `<span>${icon('clock')} ${quiz.time_limit_min} minutes</span>` : ''}${quiz.source_label ? `<span>From ${esc(quiz.source_label)}</span>` : ''}</div>
      ${noAnswer ? `<div class="feedback" style="margin-top:12px;border-color:rgba(251,191,36,.45)"><b>${noAnswer} question${noAnswer > 1 ? 's have' : ' has'} no answer yet</b> (the file didn't include one). They're skipped until you set the answer in <a href="#" id="fix">Review & edit questions</a>.</div>` : ''}
      <p class="muted small" style="margin-top:12px">${exam ? 'Answer in any order. Your score appears when you submit or when time runs out.' : 'You\'ll see if you\'re right after each question.'}</p>
      <div class="row gap wrap" style="margin-top:18px">
        <label class="field" style="margin:0;min-width:150px"><span>Questions</span><select class="input" id="howmany">${(() => { const n = answerable.length; return [...new Set([10, 20, 30, 50, 100, 200].filter((x) => x < n).concat(n))].map((x) => `<option value="${x}" ${x === n ? 'selected' : ''}>${x === n ? `All ${x}` : x}</option>`).join(''); })()}</select></label>
        <label class="field" style="margin:0;min-width:170px"><span>Subject</span>${subjectSelectHtml(quiz.folder_id, { id: 'qsub' })}</label>
      </div>
      <div class="row gap wrap" style="margin-top:16px">
        <button class="btn primary" id="start">${icon('play')} Start ${exam ? 'exam' : 'quiz'}</button>
        <a class="btn" href="#/learn/quiz/${quiz.id}" title="Missed questions repeat until you get them right">${icon('target')} Learn mode</a>
        <label class="small muted row gap"><input type="checkbox" id="shuf" checked> Shuffle</label>
        <span class="grow"></span>
        <button class="btn ghost sm" id="edit">${icon('edit')} Review & edit questions</button>
      </div>
    </div>
    ${attempts.length ? `<div class="card"><div class="card-head"><h3>Past attempts</h3></div><div class="stack" style="gap:8px">
      ${attempts.slice(0, 8).map((a) => `<div class="row gap"><span class="grow small">${timeAgo(a.created_at)}${a.duration_s ? ` · ${Math.max(1, Math.round(a.duration_s / 60))} min` : ''}</span><div class="progress thin" style="width:120px"><i style="width:${pct(a.score, a.total)}%"></i></div><b class="small" style="width:44px;text-align:right">${pct(a.score, a.total)}%</b></div>`).join('')}
    </div></div>` : ''}
  </div>`;
  el.querySelector('#start').addEventListener('click', () => {
    const n = Number(el.querySelector('#howmany').value) || quiz.questions.length;
    if (!answerable.length) return toast('Set the answers first in “Review & edit questions”', 'err');
    const qs = (el.querySelector('#shuf').checked ? shuffle(answerable) : answerable).slice(0, n);
    run(el, quiz, qs.map((q) => ({ ...q, options: q.type === 'mcq' && q.number == null ? shuffle(q.options || []) : q.options })), true);
  });
  el.querySelector('#edit').addEventListener('click', () => editQuestions(el, quiz));
  el.querySelector('#fix')?.addEventListener('click', (e) => { e.preventDefault(); editQuestions(el, quiz); });
  bindSubjectSelect(el.querySelector('#qsub'), async (v) => { await db.update('quizzes', quiz.id, { folder_id: v }); quiz.folder_id = v; toast('Subject updated', 'ok'); });
}

function run(el, quiz, questions, record) {
  const exam = quiz.kind === 'exam';
  const answers = new Array(questions.length).fill(null);
  const checked = new Array(questions.length).fill(false);
  let i = 0;
  const started = Date.now();
  const limit = exam && quiz.time_limit_min ? quiz.time_limit_min * 60 : null;
  let timer = null, finished = false;

  el.innerHTML = `<div class="quiz-wrap">
    <div class="row gap"><button class="icon-btn sm" id="quit" aria-label="Quit">${icon('x')}</button>
      <div class="grow"><div class="small muted">${esc(quiz.title)}</div><div class="bar-progress" style="margin-top:6px"><i id="bar"></i></div></div>
      ${limit ? `<span class="tag timer" id="timer"></span>` : ''}</div>
    ${exam ? '<div class="dots" id="dots"></div>' : ''}
    <div id="qbox"></div></div>`;
  const qbox = el.querySelector('#qbox');

  if (limit) {
    const tick = () => {
      const left = limit - Math.floor((Date.now() - started) / 1000);
      const t = el.querySelector('#timer');
      if (!t) return;
      t.textContent = `${Math.floor(Math.max(0, left) / 60)}:${String(Math.max(0, left) % 60).padStart(2, '0')}`;
      t.classList.toggle('low', left <= 60);
      if (left <= 0) { toast('Time\'s up!'); submit(); }
    };
    tick(); timer = setInterval(tick, 1000);
  }
  state.cleanup.push(() => clearInterval(timer));

  el.querySelector('#quit').addEventListener('click', async () => {
    if (finished || answers.every((a) => a == null) || await confirmBox({ title: 'Leave this attempt?', message: 'Your answers so far won\'t be saved.', confirmText: 'Leave' })) { clearInterval(timer); intro(el, quiz); }
  });

  const drawDots = () => {
    const d = el.querySelector('#dots'); if (!d) return;
    d.innerHTML = questions.map((_, k) => `<button class="${answers[k] != null && answers[k] !== '' ? 'done' : ''} ${k === i ? 'cur' : ''}" data-k="${k}" aria-label="Question ${k + 1}">${k + 1}</button>`).join('');
  };
  el.querySelector('#dots')?.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { i = Number(b.dataset.k); draw(); } });

  function draw() {
    const q = questions[i];
    el.querySelector('#bar').style.width = `${pct(answers.filter((a) => a != null && a !== '').length, questions.length)}%`;
    drawDots();
    const isChecked = checked[i];
    const result = isChecked ? grade(q, answers[i]) : null;
    const optsHtml = (q.type === 'mcq' || q.type === 'tf')
      ? `<div class="opts">${(q.options || ['True', 'False']).map((o, k) => {
          let cls = answers[i] === o ? 'sel' : '';
          if (isChecked) cls = o === q.answer ? 'right' : answers[i] === o ? 'wrong' : '';
          return `<button class="opt ${cls}" data-o="${esc(o)}" ${isChecked ? 'disabled' : ''}><span class="key">${q.type === 'tf' ? (o === 'True' ? 'T' : 'F') : 'ABCDEFG'[k]}</span><span>${esc(o)}</span></button>`;
        }).join('')}</div>`
      : `<textarea class="textarea" id="ans" rows="${q.type === 'short' ? 4 : 1}" placeholder="${q.type === 'fill' ? 'Type the missing word or phrase' : 'Write your answer'}" ${isChecked ? 'disabled' : ''}>${esc(answers[i] || '')}</textarea>`;
    qbox.innerHTML = `<div class="card q-card">
      <div class="q-num">Question ${i + 1} of ${questions.length} <span class="tag plain">${TYPE_LABEL[q.type] || ''}</span></div>
      <div class="q-prompt">${esc(q.prompt)}</div>
      ${optsHtml}
      ${isChecked ? feedback(q, answers[i], result) : ''}
    </div>
    <div class="row gap" style="margin-top:14px">
      <button class="btn" id="prev" ${i === 0 ? 'disabled' : ''}>${icon('back')} Back</button>
      <span class="grow"></span>
      ${exam
        ? (i < questions.length - 1 ? `<button class="btn primary" id="next">Next</button>` : `<button class="btn primary" id="submit">${icon('check')} Submit exam</button>`)
        : (!isChecked ? `<button class="btn primary" id="check">Check</button>` : i < questions.length - 1 ? `<button class="btn primary" id="next">Next</button>` : `<button class="btn primary" id="submit">${icon('check')} See results</button>`)}
    </div>`;
    qbox.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      answers[i] = b.dataset.o;
      if (!exam) { checked[i] = true; }
      draw();
    }));
    const ans = qbox.querySelector('#ans');
    if (ans) {
      ans.addEventListener('input', () => { answers[i] = ans.value; if (exam) drawDots(); });
      ans.addEventListener('keydown', (e) => { if (e.key === 'Enter' && q.type === 'fill') { e.preventDefault(); qbox.querySelector('#check,#next,#submit')?.click(); } });
      if (!isChecked && matchMedia('(pointer:fine)').matches) ans.focus();
    }
    qbox.querySelector('#prev')?.addEventListener('click', () => { i--; draw(); });
    qbox.querySelector('#next')?.addEventListener('click', () => { i++; draw(); });
    qbox.querySelector('#check')?.addEventListener('click', () => { checked[i] = true; draw(); });
    qbox.querySelector('#submit')?.addEventListener('click', async () => {
      const blank = answers.filter((a) => a == null || a === '').length;
      if (exam && blank && !await confirmBox({ title: 'Submit exam?', message: `${blank} question${blank > 1 ? 's are' : ' is'} unanswered.`, confirmText: 'Submit', danger: false })) return;
      submit();
    });
  }

  async function submit() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const results = questions.map((q, k) => grade(q, answers[k]));
    const duration = Math.round((Date.now() - started) / 1000);
    let attempt = null;
    const scored = results.filter((r) => r === true).length;
    if (record) {
      try {
        attempt = await db.insert('quiz_attempts', { quiz_id: quiz.id, score: scored, total: questions.length, duration_s: duration, answers: questions.map((q, k) => ({ id: q.id, given: answers[k], correct: results[k] })) });
      } catch (e) { toast('Couldn\'t save your score: ' + e.message, 'err'); }
    }
    showResults(el, quiz, questions, answers, results, duration, attempt);
  }

  draw();
}

function feedback(q, given, result) {
  if (q.type === 'short') return `<div class="feedback"><b>Model answer:</b> ${esc(q.answer)}<div class="tiny muted" style="margin-top:6px">Compare with yours — you'll mark it on the results page.</div></div>`;
  return `<div class="feedback ${result ? 'ok' : 'no'}"><b>${result ? 'Correct!' : given ? 'Not quite.' : 'No answer.'}</b>${result ? '' : ` Answer: <b>${esc(q.answer)}</b>`}${q.explanation ? `<div class="small muted" style="margin-top:6px">${esc(q.explanation)}</div>` : ''}</div>`;
}

function showResults(el, quiz, questions, answers, results, duration, attempt) {
  const draw = () => {
    const score = results.filter((r) => r === true).length;
    const pending = results.filter((r) => r === null && true).length;
    const p = pct(score, questions.length);
    const missed = questions.filter((_, k) => results[k] !== true);
    el.innerHTML = `<div class="quiz-wrap">
      <div class="card hl result-head" style="padding:26px">
        ${ring(p)}
        <div class="grow" style="min-width:200px">
          <h2>${p >= 90 ? 'Outstanding!' : p >= 75 ? 'Great work!' : p >= 50 ? 'Good effort' : 'Keep practising'}</h2>
          <p class="muted" style="margin-top:6px">${score} of ${questions.length} correct · ${Math.floor(duration / 60)}m ${duration % 60}s</p>
          ${pending ? `<p class="small" style="margin-top:8px;color:#ffd38a">${pending} short answer${pending > 1 ? 's' : ''} to mark below.</p>` : ''}
          <div class="row gap wrap" style="margin-top:16px">
            ${missed.length ? `<button class="btn primary" id="redo">${icon('shuffle')} Practise ${missed.length} missed</button>` : ''}
            <button class="btn" id="again">Retake all</button>
            <a class="btn ghost" href="#/quizzes">Done</a></div>
        </div>
      </div>
      <h3 style="margin-top:6px">Review</h3>
      ${questions.map((q, k) => `<div class="card q-card">
        <div class="q-num">${k + 1}. ${TYPE_LABEL[q.type] || ''} ${results[k] === true ? `<span class="tag" style="background:rgba(52,211,153,.15);border-color:rgba(52,211,153,.4);color:#a7f3d0">Correct</span>` : results[k] === false ? `<span class="tag" style="background:rgba(248,113,133,.15);border-color:rgba(248,113,133,.4);color:#fecdd3">Incorrect</span>` : '<span class="tag plain">Mark it</span>'}</div>
        <div class="q-prompt" style="font-size:16px">${esc(q.prompt)}</div>
        <div class="small"><span class="muted">Your answer:</span> ${answers[k] ? esc(answers[k]) : '<i class="dim">blank</i>'}</div>
        <div class="small" style="margin-top:4px"><span class="muted">${q.type === 'short' ? 'Model answer' : 'Correct answer'}:</span> <b>${esc(q.answer)}</b></div>
        ${q.explanation && q.explanation !== q.answer ? `<div class="tiny muted" style="margin-top:8px">${esc(q.explanation)}</div>` : ''}
        ${q.type === 'short' || (q.type === 'fill' && results[k] === false && answers[k]) ? `<div class="row gap" style="margin-top:10px"><span class="tiny muted">${q.type === 'fill' ? 'Was your answer actually right?' : 'How did you do?'}</span><button class="btn sm" data-mark="${k}" data-v="1">${icon('check')} I got it</button><button class="btn sm ghost" data-mark="${k}" data-v="0">I missed it</button></div>` : ''}
      </div>`).join('')}
    </div>`;
    el.querySelector('#again').addEventListener('click', () => intro(el, quiz));
    el.querySelector('#redo')?.addEventListener('click', () => run(el, { ...quiz, kind: 'quiz', title: `${quiz.title} — missed`, time_limit_min: null }, shuffle(missed), false));
    el.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', async () => {
      results[Number(b.dataset.mark)] = b.dataset.v === '1';
      if (attempt) {
        try { attempt = await db.update('quiz_attempts', attempt.id, { score: results.filter((r) => r === true).length, answers: questions.map((q, k) => ({ id: q.id, given: answers[k], correct: results[k] })) }); } catch { /* keep going */ }
      }
      const y = scrollY, vy = el.scrollTop; draw(); el.scrollTop = vy; scrollTo(0, y);
    }));
  };
  draw();
}

function editQuestions(el, quiz) {
  const draw = () => `<div class="stack">
    <div class="card" style="padding:14px;border-color:rgba(79,124,255,.4)"><div class="row gap wrap"><b class="small grow">Answer key</b><span class="tiny muted">${quiz.questions.filter((q) => q.answer == null || q.answer === '').length} without an answer</span></div>
      <textarea class="textarea" id="akey" rows="2" style="margin-top:8px" placeholder="Type or paste: 1.B 2.C 3.A 4.True …  or just BCATD…"></textarea>
      <div class="row end" style="margin-top:8px"><button class="btn sm primary" id="akey-go">Apply key</button></div></div>
    ${quiz.questions.map((q, k) => `<div class="card" style="padding:14px">
      <div class="row gap" style="align-items:flex-start"><div class="grow"><div class="tiny muted">${k + 1} · ${TYPE_LABEL[q.type]}</div><div class="small" style="white-space:pre-line;margin-top:4px">${esc(q.prompt)}</div>
      ${q.answer != null && q.answer !== '' ? `<div class="tiny" style="margin-top:6px;color:var(--good)">✓ ${esc(q.answer)}</div>` : '<div class="tiny" style="margin-top:6px;color:#ffd38a">No answer yet — tap edit to set it</div>'}</div>
      <button class="icon-btn sm" data-e="${k}" aria-label="Edit">${icon('edit')}</button><button class="icon-btn sm" data-d="${k}" aria-label="Delete">${icon('trash')}</button></div></div>`).join('')}</div>`;
  const m = modal({ title: `Questions (${quiz.questions.length})`, wide: true, body: draw(), onClose: () => intro(el, quiz) });
  const body = m.el.querySelector('.modal-body');
  body.addEventListener('click', async (e) => {
    if (e.target.closest('#akey-go')) {
      const n = applyAnswerKey(quiz.questions, body.querySelector('#akey').value);
      if (!n) return toast('Couldn\'t read that key — try “1.B 2.C 3.A”', 'err');
      await db.update('quizzes', quiz.id, { questions: quiz.questions });
      toast(`Set ${n} answer${n > 1 ? 's' : ''}`, 'ok'); body.innerHTML = draw();
      return;
    }
    const d = e.target.closest('[data-d]');
    if (d) {
      if (quiz.questions.length <= 1) return toast('A quiz needs at least one question', 'err');
      quiz.questions.splice(Number(d.dataset.d), 1);
      await db.update('quizzes', quiz.id, { questions: quiz.questions });
      body.innerHTML = draw(); m.el.querySelector('.modal-head h3').textContent = `Questions (${quiz.questions.length})`;
      return;
    }
    const ed = e.target.closest('[data-e]');
    if (ed) {
      const k = Number(ed.dataset.e), q = quiz.questions[k];
      body.innerHTML = `<form id="qe">
        <label class="field"><span>Question</span><textarea name="prompt" rows="3" required>${esc(q.prompt)}</textarea></label>
        ${q.type === 'mcq' ? `<label class="field"><span>Options (one per line)</span><textarea name="options" rows="4">${esc((q.options || []).join('\n'))}</textarea></label>` : ''}
        ${q.type === 'tf' ? `<label class="field"><span>Correct answer</span><select name="answer"><option ${q.answer === 'True' ? 'selected' : ''}>True</option><option ${q.answer === 'False' ? 'selected' : ''}>False</option></select></label>`
          : q.type === 'mcq' ? `<div class="field"><span>Correct answer (tap the right choice)</span><div class="opts" id="pick">${(q.options || []).map((o, i) => `<label class="opt ${o === q.answer ? 'sel' : ''}" style="cursor:pointer"><input type="radio" name="answer" value="${esc(o)}" ${o === q.answer ? 'checked' : ''} style="display:none"><span class="key">${'ABCDEFGH'[i]}</span><span>${esc(o)}</span></label>`).join('')}</div></div>`
          : `<label class="field"><span>Correct answer</span><input name="answer" value="${esc(q.answer ?? '')}" required></label>`}
        <div class="row end gap"><button type="button" class="btn ghost" id="qe-cancel">Cancel</button><button class="btn primary">Save</button></div></form>`;
      body.querySelector('#qe-cancel').addEventListener('click', () => { body.innerHTML = draw(); });
      body.querySelector('#pick')?.addEventListener('change', () => body.querySelectorAll('#pick .opt').forEach((l) => l.classList.toggle('sel', l.querySelector('input').checked)));
      body.querySelector('#qe').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const ansVal = (f.querySelector('[name=answer]:checked') || f.querySelector('select[name=answer], input[name=answer]:not([type=radio])'))?.value?.trim() || '';
        const upd = { ...q, prompt: f.prompt.value.trim(), answer: ansVal || null };
        if (q.type === 'mcq') {
          const oldOpts = q.options || [];
          upd.options = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
          // keep the chosen answer if its option text was edited in the same position
          const idx = oldOpts.indexOf(upd.answer);
          if (idx > -1 && !upd.options.includes(upd.answer)) upd.answer = upd.options[idx] || null;
          if (!upd.answer) return toast('Tap the correct choice', 'err');
        }
        if (q.type === 'tf' && !['True', 'False'].includes(upd.answer)) return toast('Answer must be True or False', 'err');
        quiz.questions[k] = upd;
        await db.update('quizzes', quiz.id, { questions: quiz.questions });
        toast('Saved', 'ok'); body.innerHTML = draw();
      });
    }
  });
}
