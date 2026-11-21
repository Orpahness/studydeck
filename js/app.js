import { auth, db } from './store.js';
import { $, $$, esc, icon, toast, fmtDate, modal, promptBox, confirmBox, SWATCHES } from './util.js';
import { APP_NAME } from './config.js';

export const state = { profile: null, folders: [], cleanup: [], aiEnabled: false };

const ROUTES = {
  '': { view: 'dashboard', title: 'Dashboard', nav: 'home' },
  notes: { view: 'notes', title: 'Notes', nav: 'notes' },
  library: { view: 'library', title: 'Library', nav: 'library' },
  decks: { view: 'decks', title: 'Flashcards', nav: 'decks' },
  study: { view: 'study', title: 'Study session', nav: 'decks' },
  learn: { view: 'learn', title: 'Learn', nav: 'decks' },
  quizzes: { view: 'quizzes', title: 'Quizzes & exams', nav: 'quizzes' },
  quiz: { view: 'take', title: 'Quiz', nav: 'quizzes' },
  progress: { view: 'progress', title: 'Progress', nav: 'progress' },
  settings: { view: 'settings', title: 'Settings', nav: 'settings' },
};
const NAV = [
  ['home', '#/', 'home', 'Dashboard'],
  ['notes', '#/notes', 'note', 'Notes'],
  ['library', '#/library', 'book', 'Library'],
  ['decks', '#/decks', 'cards', 'Flashcards'],
  ['quizzes', '#/quizzes', 'quiz', 'Quizzes'],
  ['progress', '#/progress', 'chart', 'Progress'],
];

export const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
export function setCrumb(text) { const el = $('#crumb-page'); if (el) el.textContent = text; }
export async function refreshFolders() { state.folders = await db.list('folders', { order: 'name' }); return state.folders; }
export function folderById(id) { return state.folders.find((f) => f.id === id); }
/** The subject chosen under "Studying" on the dashboard (null = all subjects). */
export const focusId = () => (state.profile?.focus_folder_id && folderById(state.profile.focus_folder_id) ? state.profile.focus_folder_id : null);
export async function setFocus(id) {
  state.profile = await db.saveProfile({ focus_folder_id: id || null });
}

/** <select> of subjects with a "+ New subject…" entry; pair with bindSubjectSelect. */
export function subjectSelectHtml(selected, { id = 'subject', allLabel = 'No subject', cls = 'input' } = {}) {
  return `<select class="${cls}" id="${id}" name="${id}">
    <option value="">${allLabel}</option>
    ${state.folders.map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
    <option value="__new">+ New subject…</option></select>`;
}
export function bindSubjectSelect(sel, onChange) {
  let prev = sel.value;
  sel.addEventListener('change', async () => {
    if (sel.value === '__new') {
      const name = await promptBox({ title: 'New subject', label: 'Subject name (e.g. Biology 101)', confirmText: 'Add' });
      if (!name) { sel.value = prev; return; }
      const fid = await ensureFolder(name);
      const opt = new Option(name, fid, true, true);
      sel.insertBefore(opt, sel.querySelector('option[value="__new"]'));
      sel.value = fid;
    }
    prev = sel.value;
    onChange?.(sel.value || null);
  });
}

/** Add / rename / recolour / delete subjects. `after` runs when the dialog closes. */
export function manageSubjects(after) {
  const draw = () => `<div class="stack">
    ${state.folders.length ? state.folders.map((f) => `<div class="row gap subj-row" data-id="${f.id}">
        <button class="swatch-btn" data-a="color" aria-label="Change colour" style="background:${esc(f.color)}"></button>
        <span class="grow" style="font-weight:500">${esc(f.name)}</span>
        <button class="btn sm ghost" data-a="ren">${icon('edit')} Rename</button>
        <button class="btn sm ghost" data-a="del" style="color:#ffb3bf">${icon('trash')} Delete</button></div>`).join('')
      : '<p class="muted small">No subjects yet.</p>'}
    <button class="btn" data-a="add">${icon('plus')} Add subject</button></div>`;
  const m = modal({ title: 'Subjects', body: draw(), onClose: after });
  const body = m.el.querySelector('.modal-body');
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'add') {
      const name = await promptBox({ title: 'New subject', label: 'Subject name', confirmText: 'Add' });
      if (name) await ensureFolder(name);
      body.innerHTML = draw(); return;
    }
    const f = folderById(e.target.closest('[data-id]').dataset.id);
    if (a === 'color') {
      const next = SWATCHES[(SWATCHES.indexOf(f.color) + 1) % SWATCHES.length];
      await db.update('folders', f.id, { color: next });
    }
    if (a === 'ren') {
      const name = await promptBox({ title: 'Rename subject', label: 'New name', value: f.name, confirmText: 'Rename' });
      if (name && name !== f.name) { await db.update('folders', f.id, { name }); toast('Renamed', 'ok'); }
    }
    if (a === 'del') {
      const choice = await new Promise((resolve) => {
        let done = false;
        const d = modal({
          title: `Delete “${f.name}”?`,
          body: `<p class="muted small" style="margin-bottom:16px">What should happen to the notes, files, flashcards and quizzes in this subject?</p>
            <div class="stack"><button class="btn" data-c="keep">Keep them (move to “No subject”)</button>
            <button class="btn danger" data-c="all">${icon('trash')} Delete them too — permanently</button>
            <button class="btn ghost" data-close>Cancel</button></div>`,
          onClose: () => { if (!done) resolve(null); },
        });
        d.el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { done = true; resolve(b.dataset.c); d.close(); }));
      });
      if (!choice) return;
      if (choice === 'all') {
        if (!await confirmBox({ title: 'Delete everything in it?', message: `All notes, files, decks and quizzes in “${f.name}” will be erased permanently.`, confirmText: 'Delete all', requireText: 'DELETE' })) return;
        const { files } = await import('./store.js');
        const docs = await db.list('documents', { eq: { folder_id: f.id }, select: 'id,file_path' });
        await files.remove(docs.map((d) => d.file_path)).catch(() => {});
        for (const t of ['notes', 'documents', 'decks', 'quizzes']) await db.removeWhere(t, { folder_id: f.id });
      }
      if (state.profile?.focus_folder_id === f.id) await setFocus(null);
      await db.remove('folders', f.id);
      toast('Subject deleted');
    }
    await refreshFolders();
    body.innerHTML = draw();
  });
}

export async function ensureFolder(name) {
  if (!name) return null;
  const hit = state.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const palette = ['#4f7cff', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4f6b', '#22c55e', '#0ea5e9', '#ec4899'];
  const f = await db.insert('folders', { name, color: palette[state.folders.length % palette.length] });
  state.folders.push(f);
  return f.id;
}

// ------------------------------------------------------------------ boot
async function boot() {
  let user = null;
  try { user = await auth.init(); } catch (e) { console.error(e); }
  if (!user) return renderAuth();
  try {
    state.profile = await db.profile();
    await refreshFolders();
  } catch (e) {
    console.error(e);
    toast('Could not load your data: ' + e.message, 'err');
  }
  renderShell();
  window.addEventListener('hashchange', route);
  route();
  if (auth.mode === 'cloud') fetch('/api/generate').then((r) => (r.ok ? r.json() : null)).then((j) => { state.aiEnabled = !!j?.enabled; }).catch(() => {});
}

function initials() {
  const n = state.profile?.display_name || auth.user?.user_metadata?.display_name || auth.user?.email || 'S';
  return n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
}

function renderShell() {
  $('#root').innerHTML = `
  <div class="app">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand"><div class="brand-mark">${icon('sparkle')}</div><span>${APP_NAME}</span></div>
      <nav class="nav">${NAV.map(([k, h, i, l]) => `<a href="${h}" data-nav="${k}"><span class="nav-ico">${icon(i)}</span><span>${l}</span>${k === 'decks' ? '<b class="count hidden" id="due-count"></b>' : ''}</a>`).join('')}</nav>
      <nav class="nav side-foot">
        <a href="#/settings" data-nav="settings"><span class="nav-ico">${icon('settings')}</span><span>Settings</span></a>
        <a href="#" id="logout"><span class="nav-ico">${icon('logout')}</span><span>Log out</span></a>
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="crumbs"><span class="hide-sm">${icon('home')}</span><span class="hide-sm">Home</span><span class="sep hide-sm">/</span><b id="crumb-page">Dashboard</b><span class="sep hide-sm">/</span><span class="hide-sm">${fmtDate()}</span></div>
        <div class="top-actions">
          <span class="mode-pill" title="${auth.mode === 'cloud' ? 'Synced to your private account' : 'Stored only in this browser'}">${icon(auth.mode === 'cloud' ? 'cloud' : 'device')}<span>${auth.mode === 'cloud' ? 'Private cloud' : 'This device only'}</span></span>
          <button class="icon-btn" id="search-btn" aria-label="Search">${icon('search')}</button>
          <button class="avatar" id="avatar" aria-label="Account menu">${esc(initials())}</button>
        </div>
      </header>
      <section class="view" id="view" tabindex="-1"></section>
    </main>
  </div>
  <nav class="bottom-nav" aria-label="Main navigation">
    ${[['home', '#/', 'home', 'Home'], ['notes', '#/notes', 'note', 'Notes'], ['library', '#/library', 'book', 'Library'], ['decks', '#/decks', 'cards', 'Cards'], ['quizzes', '#/quizzes', 'quiz', 'Quizzes']]
      .map(([k, h, i, l]) => `<a href="${h}" data-nav="${k}">${icon(i)}<span>${l}</span></a>`).join('')}
  </nav>`;
  $('#logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await auth.signOut();
    location.hash = '';
    location.reload();
  });
  $('#avatar').addEventListener('click', (e) => openAccountMenu(e.currentTarget));
  $('#search-btn').addEventListener('click', openSearch);
  updateDueCount();
}

export async function updateDueCount() {
  try {
    const cards = await db.list('cards', { select: 'id,due_at' });
    const n = cards.filter((c) => new Date(c.due_at) <= new Date()).length;
    const el = $('#due-count');
    if (el) { el.textContent = n; el.classList.toggle('hidden', !n); }
  } catch { /* ignore */ }
}

function openAccountMenu(anchor) {
  $$('.menu').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu';
  m.style.top = `${r.bottom + 8 + window.scrollY}px`;
  m.style.right = `${Math.max(10, innerWidth - r.right)}px`;
  m.innerHTML = `
    <div style="padding:8px 12px 10px"><b>${esc(state.profile?.display_name || 'Student')}</b><div class="tiny muted">${esc(auth.user?.email || 'Stored on this device only')}</div></div>
    <button data-h="#/progress">${icon('chart')} Progress</button>
    <button data-h="#/settings">${icon('settings')} Settings & privacy</button>
    <button data-act="logout">${icon('logout')} Log out</button>`;
  document.body.append(m);
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off, true); } };
  setTimeout(() => document.addEventListener('click', off, true));
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    m.remove();
    if (b.dataset.h) go(b.dataset.h);
    if (b.dataset.act === 'logout') { await auth.signOut(); location.hash = ''; location.reload(); }
  });
}

async function openSearch() {
  const m = modal({
    title: 'Search everything', wide: true,
    body: `<div class="search"><span>${icon('search')}</span><input class="input" id="gs" placeholder="Search notes, books, decks, quizzes…" autocomplete="off"></div><div id="gs-out" class="stack" style="margin-top:14px"></div>`,
  });
  const [notes, docs, decks, quizzes] = await Promise.all([
    db.list('notes', { select: 'id,title,content,tags' }), db.list('documents', { select: 'id,title' }),
    db.list('decks', { select: 'id,title' }), db.list('quizzes', { select: 'id,title,kind' }),
  ]);
  const input = m.el.querySelector('#gs'), out = m.el.querySelector('#gs-out');
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { out.innerHTML = '<p class="muted small">Type to search.</p>'; return; }
    const hits = [
      ...notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || (n.tags || []).some((t) => t.includes(q))).map((n) => ['note', n.title, `#/notes/${n.id}`, 'Note']),
      ...docs.filter((d) => d.title.toLowerCase().includes(q)).map((d) => ['book', d.title, `#/library/${d.id}`, 'Library']),
      ...decks.filter((d) => d.title.toLowerCase().includes(q)).map((d) => ['cards', d.title, `#/decks/${d.id}`, 'Deck']),
      ...quizzes.filter((d) => d.title.toLowerCase().includes(q)).map((d) => ['quiz', d.title, `#/quizzes`, d.kind === 'exam' ? 'Exam' : 'Quiz']),
    ].slice(0, 30);
    out.innerHTML = hits.length
      ? `<div class="list">${hits.map(([i, t, h, k]) => `<a class="item" href="${h}" data-close><span class="item-ico">${icon(i)}</span><div class="grow"><div class="item-title">${esc(t)}</div><div class="item-meta">${k}</div></div></a>`).join('')}</div>`
      : '<p class="muted small">No matches.</p>';
  };
  input.addEventListener('input', run);
  run();
}

// ------------------------------------------------------------------ router
const viewModules = {};
async function route() {
  state.cleanup.forEach((f) => { try { f(); } catch { /* */ } });
  state.cleanup = [];
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const key = parts[0] || '';
  const r = ROUTES[key] || ROUTES[''];
  const nav = key === 'learn' && parts[1] === 'quiz' ? 'quizzes' : r.nav;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  setCrumb(r.title);
  document.title = `${r.title} · ${APP_NAME}`;
  const el = $('#view');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  el.scrollTop = 0; window.scrollTo(0, 0);
  try {
    const mod = viewModules[r.view] || (viewModules[r.view] = await import(`./views/${r.view}.js`));
    await mod.render(el, parts.slice(1));
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty">${icon('x')}<h3>Something went wrong</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
}

// ------------------------------------------------------------------ auth screen
function renderAuth() {
  let tab = 'in';
  const draw = () => {
    $('#root').innerHTML = `
    <div class="auth"><div class="card auth-card">
      <div class="brand"><div class="brand-mark">${icon('sparkle')}</div><span>${APP_NAME}</span></div>
      <h1>${tab === 'in' ? 'Welcome back' : tab === 'up' ? 'Create your account' : 'Reset password'}</h1>
      <p class="sub">Notes, flashcards and quizzes in one place.</p>
      ${tab !== 'reset' ? `<div class="seg" style="width:100%;margin-bottom:18px"><button class="grow ${tab === 'in' ? 'on' : ''}" data-tab="in">Sign in</button><button class="grow ${tab === 'up' ? 'on' : ''}" data-tab="up">Create account</button></div>` : ''}
      <form id="auth-form">
        ${tab === 'up' ? '<label class="field"><span>Your name</span><input name="name" autocomplete="name" required></label>' : ''}
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
        ${tab !== 'reset' ? `<label class="field"><span>Password</span><input name="password" type="password" minlength="8" autocomplete="${tab === 'up' ? 'new-password' : 'current-password'}" required></label>` : ''}
        <button class="btn primary" style="width:100%" id="auth-go">${tab === 'in' ? 'Sign in' : tab === 'up' ? 'Create account' : 'Send reset link'}</button>
        <p class="small muted" id="auth-msg" style="margin-top:12px;text-align:center"></p>
        <p class="small" style="text-align:center">${tab === 'in' ? '<a href="#" data-tab="reset">Forgot password?</a>' : tab === 'reset' ? '<a href="#" data-tab="in">Back to sign in</a>' : ''}</p>
      </form>
      <div class="divider">or</div>
      <button class="btn" style="width:100%" id="local-go">${icon('device')} Use without an account</button>
      <div class="privacy-note">${icon('shield')}<div>Your study data is private to your account — other users can never see it. Deleting something deletes it permanently; there's no recycle bin. "Without an account" keeps everything in this browser only.</div></div>
    </div></div>`;
    $$('[data-tab]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); tab = b.dataset.tab; draw(); }));
    $('#local-go').addEventListener('click', async () => {
      const m = modal({ title: 'Use on this device only', body: `<form id="lf"><p class="muted small" style="margin-bottom:14px">Everything stays in this browser. It won't sync to your other devices, and clearing your browser data erases it.</p><label class="field"><span>What should we call you?</span><input id="ln" placeholder="Student" autocomplete="given-name"></label><button class="btn primary" style="width:100%">Start studying</button></form>` });
      m.el.querySelector('#lf').addEventListener('submit', async (e) => { e.preventDefault(); await auth.useLocal(m.el.querySelector('#ln').value.trim()); m.close(); boot(); });
    });
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), msg = $('#auth-msg'), btn = $('#auth-go');
      btn.disabled = true; msg.textContent = '';
      try {
        if (tab === 'in') { await auth.signIn(f.get('email'), f.get('password')); return boot(); }
        if (tab === 'reset') { await auth.sendReset(f.get('email')); msg.textContent = 'Check your inbox for a reset link.'; return; }
        const r = await auth.signUp(f.get('email'), f.get('password'), f.get('name'));
        if (r.session) return boot();
        msg.innerHTML = 'Almost there — check your email and click the confirmation link, then sign in.';
      } catch (err) {
        msg.textContent = /fetch|network|import/i.test(err.message) ? 'Can\'t reach the server. Check your connection.' : err.message;
      } finally { btn.disabled = false; }
    });
  };
  draw();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
