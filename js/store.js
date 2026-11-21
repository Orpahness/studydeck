// Data layer with two interchangeable backends:
//  - "cloud": Supabase (account, syncs across devices, Row Level Security)
//  - "local": IndexedDB in this browser only (no account, nothing leaves the device)
// Views only ever talk to `db`, `files` and `auth` exported below.
import { SUPABASE_URL, SUPABASE_KEY, STORAGE_BUCKET } from './config.js';

const TABLES = ['folders', 'notes', 'documents', 'decks', 'cards', 'quizzes', 'quiz_attempts', 'study_logs', 'profiles'];
const MODE_KEY = 'studydeck.mode';
const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

// ---------------------------------------------------------------- local (IndexedDB)
let idbPromise;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('studydeck-local', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
function tx(store, mode, fn) {
  return idb().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const LOCAL_CASCADE = {
  decks: [['cards', 'deck_id', 'delete'], ['study_logs', 'deck_id', 'delete']],
  cards: [['study_logs', 'card_id', 'delete']],
  quizzes: [['quiz_attempts', 'quiz_id', 'delete']],
  folders: [['notes', 'folder_id', 'null'], ['documents', 'folder_id', 'null'], ['decks', 'folder_id', 'null'], ['quizzes', 'folder_id', 'null']],
};

// mirror the database column defaults so both backends return the same shape
const LOCAL_DEFAULTS = {
  cards: () => ({ ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: now(), last_reviewed_at: null }),
  notes: () => ({ title: 'Untitled note', content: '', tags: [], pinned: false, folder_id: null, updated_at: now() }),
  decks: () => ({ description: '', color: '#4f7cff', folder_id: null }),
  quizzes: () => ({ kind: 'quiz', questions: [], folder_id: null, time_limit_min: null }),
  folders: () => ({ color: '#4f7cff' }),
  documents: () => ({ text_content: '', folder_id: null }),
};

const localDb = {
  async list(table, opts = {}) {
    let rows = await tx(table, 'readonly', (s) => reqP(s.getAll()));
    if (opts.eq) rows = rows.filter((r) => Object.entries(opts.eq).every(([k, v]) => r[k] === v));
    if (opts.order) {
      const k = opts.order, dir = opts.desc ? -1 : 1;
      rows.sort((a, b) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0));
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  },
  async get(table, id) { return (await tx(table, 'readonly', (s) => reqP(s.get(id)))) || null; },
  async insert(table, data) {
    const many = Array.isArray(data);
    const rows = (many ? data : [data]).map((r) => ({ id: uid(), user_id: 'local', created_at: now(), ...(LOCAL_DEFAULTS[table]?.() || {}), ...r }));
    await tx(table, 'readwrite', (s) => { rows.forEach((r) => s.put(r)); });
    return many ? rows : rows[0];
  },
  async update(table, id, patch) {
    const cur = await this.get(table, id);
    if (!cur) throw new Error('Not found');
    const row = { ...cur, ...patch, ...(table === 'notes' ? { updated_at: now() } : {}) };
    await tx(table, 'readwrite', (s) => s.put(row));
    return row;
  },
  async remove(table, id) {
    for (const [child, fk, how] of LOCAL_CASCADE[table] || []) {
      const kids = await this.list(child, { eq: { [fk]: id } });
      for (const k of kids) {
        if (how === 'delete') await this.remove(child, k.id);
        else await tx(child, 'readwrite', (s) => s.put({ ...k, [fk]: null }));
      }
    }
    await tx(table, 'readwrite', (s) => s.delete(id));
  },
  async removeWhere(table, eq) {
    for (const r of await this.list(table, { eq })) await this.remove(table, r.id);
  },
};

const localFiles = {
  async upload(path, blob) { await tx('files', 'readwrite', (s) => s.put(blob, path)); return path; },
  async getBlob(path) { return tx('files', 'readonly', (s) => reqP(s.get(path))); },
  async remove(paths) { await tx('files', 'readwrite', (s) => paths.forEach((p) => s.delete(p))); },
};

// ---------------------------------------------------------------- cloud (Supabase)
let sb = null;
async function supa() {
  if (!sb) {
    // loaded from a CDN on first use (with a fallback CDN), so the app has no build step
    const mod = await import('https://esm.sh/@supabase/supabase-js@2').catch(() => import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'));
    const { createClient } = mod;
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }
  return sb;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const cloudDb = {
  async list(table, opts = {}) {
    const c = await supa();
    let q = c.from(table).select(opts.select || '*');
    for (const [k, v] of Object.entries(opts.eq || {})) q = v === null ? q.is(k, null) : q.eq(k, v);
    if (opts.order) q = q.order(opts.order, { ascending: !opts.desc });
    if (opts.limit) q = q.limit(opts.limit);
    return must(await q);
  },
  async get(table, id) { const c = await supa(); return must(await c.from(table).select('*').eq('id', id).maybeSingle()); },
  async insert(table, data) {
    const c = await supa();
    const many = Array.isArray(data);
    const out = [];
    const rows = many ? data : [data];
    for (let i = 0; i < rows.length; i += 500) out.push(...must(await c.from(table).insert(rows.slice(i, i + 500)).select()));
    return many ? out : out[0];
  },
  async update(table, id, patch) { const c = await supa(); return must(await c.from(table).update(patch).eq('id', id).select().single()); },
  async remove(table, id) { const c = await supa(); must(await c.from(table).delete().eq('id', id)); },
  async removeWhere(table, eq) {
    const c = await supa();
    let q = c.from(table).delete();
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
    must(await q);
  },
};

const cloudFiles = {
  async upload(path, blob) {
    const c = await supa();
    must(await c.storage.from(STORAGE_BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || 'application/octet-stream' }));
    return path;
  },
  async getBlob(path) { const c = await supa(); return must(await c.storage.from(STORAGE_BUCKET).download(path)); },
  async remove(paths) { if (!paths.length) return; const c = await supa(); must(await c.storage.from(STORAGE_BUCKET).remove(paths)); },
  async listAll(prefix) {
    const c = await supa();
    const out = [];
    const walk = async (p) => {
      const items = must(await c.storage.from(STORAGE_BUCKET).list(p, { limit: 1000 }));
      for (const it of items) {
        const full = p ? `${p}/${it.name}` : it.name;
        if (it.id) out.push(full); else await walk(full);
      }
    };
    await walk(prefix);
    return out;
  },
};

// ---------------------------------------------------------------- public API
let mode = localStorage.getItem(MODE_KEY); // 'cloud' | 'local' | null
let currentUser = null;

export const db = {
  list: (...a) => (mode === 'cloud' ? cloudDb : localDb).list(...a),
  get: (...a) => (mode === 'cloud' ? cloudDb : localDb).get(...a),
  insert: (...a) => (mode === 'cloud' ? cloudDb : localDb).insert(...a),
  update: (...a) => (mode === 'cloud' ? cloudDb : localDb).update(...a),
  remove: (...a) => (mode === 'cloud' ? cloudDb : localDb).remove(...a),
  removeWhere: (...a) => (mode === 'cloud' ? cloudDb : localDb).removeWhere(...a),
  async profile() {
    const id = currentUser?.id;
    let p = mode === 'cloud' ? await cloudDb.get('profiles', id) : await localDb.get('profiles', 'local');
    if (!p) {
      const base = { id: mode === 'cloud' ? id : 'local', display_name: currentUser?.user_metadata?.display_name || '', quick_note: '', daily_goal: 20 };
      if (mode === 'cloud') { const c = await supa(); p = must(await c.from('profiles').upsert(base).select().single()); }
      else { await tx('profiles', 'readwrite', (s) => s.put(base)); p = base; }
    }
    return p;
  },
  async saveProfile(patch) {
    const p = await this.profile();
    const row = { ...p, ...patch, updated_at: now() };
    if (mode === 'cloud') { const c = await supa(); return must(await c.from('profiles').upsert(row).select().single()); }
    await tx('profiles', 'readwrite', (s) => s.put(row));
    return row;
  },
};

export const files = {
  path(name) {
    const safe = name.replace(/[^\w.\-]+/g, '_').slice(-80);
    return `${currentUser?.id || 'local'}/${Date.now()}_${safe}`;
  },
  upload: (p, b) => (mode === 'cloud' ? cloudFiles : localFiles).upload(p, b),
  getBlob: (p) => (mode === 'cloud' ? cloudFiles : localFiles).getBlob(p),
  remove: (ps) => (mode === 'cloud' ? cloudFiles : localFiles).remove(ps.filter(Boolean)),
};

export const auth = {
  get mode() { return mode; },
  get user() { return currentUser; },

  /** Restore an existing session. Returns the user or null. */
  async init() {
    if (mode === 'local') {
      currentUser = { id: 'local', email: null, user_metadata: { display_name: localStorage.getItem('studydeck.localName') || 'Student' } };
      return currentUser;
    }
    if (mode === 'cloud' || location.hash.includes('access_token') || location.search.includes('code=')) {
      try {
        const c = await supa();
        const { data } = await c.auth.getSession();
        if (data.session) { mode = 'cloud'; localStorage.setItem(MODE_KEY, 'cloud'); currentUser = data.session.user; return currentUser; }
      } catch (e) { console.warn('Supabase unavailable', e); }
    }
    return null;
  },

  async signUp(email, password, name) {
    const c = await supa();
    const data = must(await c.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } }));
    if (data.session) { mode = 'cloud'; localStorage.setItem(MODE_KEY, 'cloud'); currentUser = data.user; }
    return data;
  },
  async signIn(email, password) {
    const c = await supa();
    const data = must(await c.auth.signInWithPassword({ email, password }));
    mode = 'cloud'; localStorage.setItem(MODE_KEY, 'cloud'); currentUser = data.user;
    return data.user;
  },
  async sendReset(email) {
    const c = await supa();
    must(await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + '#/settings' }));
  },
  async updatePassword(password) {
    const c = await supa();
    must(await c.auth.updateUser({ password }));
  },
  async useLocal(name) {
    mode = 'local'; localStorage.setItem(MODE_KEY, 'local');
    localStorage.setItem('studydeck.localName', name || 'Student');
    return this.init();
  },
  async signOut() {
    if (mode === 'cloud') { const c = await supa(); await c.auth.signOut(); }
    localStorage.removeItem(MODE_KEY);
    mode = null; currentUser = null;
  },
  async accessToken() {
    if (mode !== 'cloud') return null;
    const c = await supa();
    return (await c.auth.getSession()).data.session?.access_token || null;
  },

  /** Permanently wipe every note, deck, quiz, upload and log. Keeps the login. */
  async resetData() {
    if (mode === 'cloud') {
      const c = await supa();
      await cloudFiles.remove(await cloudFiles.listAll(currentUser.id));
      must(await c.rpc('reset_my_data'));
    } else {
      for (const t of TABLES) await tx(t, 'readwrite', (s) => s.clear());
      await tx('files', 'readwrite', (s) => s.clear());
    }
  },

  /** Permanently delete the account itself plus everything in it. */
  async deleteAccount() {
    if (mode === 'cloud') {
      const c = await supa();
      await cloudFiles.remove(await cloudFiles.listAll(currentUser.id));
      must(await c.rpc('delete_my_account'));
      await c.auth.signOut().catch(() => {});
      localStorage.removeItem(MODE_KEY);
    } else {
      await this.resetData();
      localStorage.removeItem('studydeck.localName');
      localStorage.removeItem(MODE_KEY);
    }
    mode = null; currentUser = null;
  },
};
