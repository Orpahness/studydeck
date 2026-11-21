import { db, auth } from '../store.js';
import { state } from '../app.js';
import { esc, icon, toast, confirmBox } from '../util.js';

export async function render(el) {
  const cloud = auth.mode === 'cloud';
  const p = state.profile || {};
  el.innerHTML = `<div class="stack" style="gap:18px;max-width:760px">
    <div class="page-head" style="margin-bottom:0"><div><h1>Settings</h1><p class="sub">${cloud ? esc(auth.user?.email || '') : 'Device-only mode — nothing is uploaded anywhere.'}</p></div></div>

    <form class="card" id="prof">
      <div class="card-head"><h3>Profile</h3></div>
      <div class="row gap wrap">
        <label class="field grow"><span>Display name</span><input name="name" value="${esc(p.display_name || '')}" maxlength="60"></label>
        <label class="field" style="width:180px"><span>Daily card goal</span><input name="goal" type="number" min="5" max="500" value="${p.daily_goal || 20}"></label>
      </div>
      <div class="row end"><button class="btn primary sm">Save</button></div>
    </form>

    ${cloud ? `<form class="card" id="pw">
      <div class="card-head"><h3>Change password</h3></div>
      <label class="field"><span>New password (8+ characters)</span><input name="pw" type="password" minlength="8" autocomplete="new-password" required></label>
      <div class="row end"><button class="btn sm">Update password</button></div>
    </form>` : ''}

    <div class="card">
      <div class="card-head">${icon('shield')}<h3>Privacy</h3></div>
      <ul class="small muted" style="margin:0;padding-left:18px;line-height:1.8">
        ${cloud ? `<li>Your notes, files, cards and scores are locked to your account by database rules — other users can't see them, and they don't appear to anyone else in the app.</li>
        <li>Uploaded files are stored privately and only open with your login.</li>` : `<li>Everything lives in this browser's storage only. Other devices and other people never see it.</li>
        <li>Clearing this browser's site data erases it — export a backup if you care about it.</li>`}
        <li>Deleting is permanent. There is no recycle bin and no "restore".</li>
        <li>The built-in question generator runs on your device. ${state.aiEnabled ? 'The optional AI generator sends only the text you choose to the AI service, and nothing is stored there.' : ''}</li>
      </ul>
    </div>

    <div class="card">
      <div class="card-head"><h3>Your data</h3></div>
      <p class="small muted" style="margin-bottom:12px">Download everything (notes, flashcards, quizzes, scores) as a JSON file. Uploaded PDFs aren't included — open them from the Library to save copies.</p>
      <button class="btn sm" id="export">${icon('download')} Export backup</button>
    </div>

    <div class="card" style="border-color:rgba(248,113,133,.35)">
      <div class="card-head"><h3 style="color:#ffb3bf">Danger zone</h3></div>
      <div class="row gap wrap" style="align-items:flex-start">
        <div class="grow" style="min-width:220px"><b class="small">Reset everything</b><p class="small muted">Erase all notes, files, decks, quizzes and progress. ${cloud ? 'Your login stays.' : ''} This can't be undone.</p></div>
        <button class="btn danger sm" id="reset">${icon('trash')} Reset all data</button>
      </div>
      <div class="row gap wrap" style="align-items:flex-start;margin-top:16px">
        <div class="grow" style="min-width:220px"><b class="small">${cloud ? 'Delete account' : 'Remove from this device'}</b><p class="small muted">${cloud ? 'Deletes your login and every piece of data in it, permanently. Nothing can be recovered afterwards.' : 'Erase everything and sign out of device-only mode.'}</p></div>
        <button class="btn danger sm" id="delete">${icon('x')} ${cloud ? 'Delete account' : 'Remove'}</button>
      </div>
    </div>
    <p class="tiny dim">StudyDeck · ${cloud ? 'Private cloud account' : 'Device-only mode'}</p>
  </div>`;
  const root = el.firstElementChild;

  root.querySelector('#prof').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    state.profile = await db.saveProfile({ display_name: f.name.value.trim(), daily_goal: Math.max(5, Math.min(500, Number(f.goal.value) || 20)) });
    if (auth.mode === 'local') localStorage.setItem('studydeck.localName', f.name.value.trim());
    const av = document.getElementById('avatar');
    if (av) av.textContent = (f.name.value.trim() || 'S').split(/\s+/).slice(0, 2).map((x) => x[0]?.toUpperCase() || '').join('');
    toast('Saved', 'ok');
  });
  root.querySelector('#pw')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await auth.updatePassword(e.target.pw.value); e.target.reset(); toast('Password updated', 'ok'); } catch (err) { toast(err.message, 'err'); }
  });
  root.querySelector('#export').addEventListener('click', async () => {
    const out = { app: 'StudyDeck', exported_at: new Date().toISOString(), profile: state.profile };
    for (const t of ['folders', 'notes', 'documents', 'decks', 'cards', 'quizzes', 'quiz_attempts', 'study_logs']) out[t] = await db.list(t);
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `studydeck-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  root.querySelector('#reset').addEventListener('click', async () => {
    if (!await confirmBox({ title: 'Reset all data?', message: 'Every note, file, deck, quiz and score will be erased permanently. There is no way to get it back.', confirmText: 'Erase everything', requireText: 'RESET' })) return;
    try { await auth.resetData(); state.profile = await db.profile(); state.folders = []; toast('All data erased', 'ok'); location.hash = '#/'; location.reload(); } catch (err) { toast(err.message, 'err'); }
  });
  root.querySelector('#delete').addEventListener('click', async () => {
    if (!await confirmBox({ title: cloud ? 'Delete your account?' : 'Remove everything from this device?', message: cloud ? 'Your login and all of your data will be deleted permanently. This cannot be undone or recovered.' : 'Everything stored in this browser will be erased.', confirmText: cloud ? 'Delete my account' : 'Remove', requireText: 'DELETE' })) return;
    try { await auth.deleteAccount(); location.hash = ''; location.reload(); } catch (err) { toast(err.message, 'err'); }
  });
}
