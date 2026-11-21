// Offline study-material generator. Reads plain text (notes, book chapters,
// lecture slides) and builds flashcards and quiz/exam questions from it with
// pattern rules — no API key, no data sent anywhere.
// Question shape: { id, type: 'mcq'|'tf'|'fill'|'short', prompt, options?, answer, explanation }
import { shuffle } from './util.js';

const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below between both but by can cannot could did do does doing down during each either else etc even ever every few for from further get gets got had has have having he her here hers herself him himself his how however i if in into is isn't it its itself just let like made make many may me might more most much must my myself no nor not now of off often on once one only or other ought our ours ourselves out over own per rather same she should since so some such than that the their theirs them themselves then there these they this those though through thus to too under until up upon us use used uses using very via was we well were what when where whether which while who whom whose why will with within without would yet you your yours yourself yourselves also known called example examples include includes including e.g i.e fig figure chapter section page table vs january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/));
const PRONOUN_START = /^(it|this|that|these|those|they|he|she|there|which|what|who|we|you|i|here|such|each|one|some|many|most|all|both|another|its|their|our|his|her)\b/i;

let seq = 0;
const qid = () => 'q' + Date.now().toString(36) + (seq++).toString(36);
const words = (s) => s.split(/\s+/).filter(Boolean);
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s\-*•\d.)]+/, '').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function splitSentences(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    const joined = block.split('\n').map((l) => l.trim()).filter(Boolean)
      // keep bullet / heading lines separate, join wrapped prose lines
      .reduce((acc, l) => {
        const prev = acc[acc.length - 1];
        // start a new chunk after bullets/headings/finished sentences and after short title-like lines
        // …but a line that obviously continues the previous one (wrapped PDF text) is joined back
        const continues = prev && !/[.!?:]$/.test(prev) && (/^[a-z(]/.test(l) || /[,;–-]$/.test(prev) || STOP.has(prev.split(/\s+/).pop().toLowerCase()));
        if (!continues && (!acc.length || /^([-*•#]|\d+[.)])\s/.test(l) || /[.!?:]$/.test(prev) || prev.length < 50 || /^[\w'’()\/ -]{2,50}:\s/.test(l))) acc.push(l);
        else acc[acc.length - 1] += ' ' + l;
        return acc;
      }, []);
    for (const para of joined) {
      if (/^#/.test(para)) continue;
      const parts = para.match(/[^.!?]+(?:[.!?]+(?=\s+[A-Z0-9"'(])|[.!?]+$|$)/g) || [para];
      for (const p of parts) {
        const s = clean(p);
        // skip fragments cut off mid-sentence ("…is fixed, while the")
        if (words(s).length >= 4 && !STOP.has((s.replace(/[.!?:]+$/, '').split(/\s+/).pop() || '').toLowerCase())) out.push(s);
      }
    }
  }
  return out;
}

function validTerm(t) {
  const w = words(t);
  if (!t || w.length > 6 || t.length < 2 || t.length > 60) return false;
  if (PRONOUN_START.test(t)) return false;
  if (w.every((x) => STOP.has(x.toLowerCase()))) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^(chapter|section|unit|lesson|part|module|week|page|slide|figure|table|lecture|topic|key terms?|summary|introduction|conclusion|objectives?|notes?)\b/i.test(t)) return false;
  return true;
}

/** Finds "term → meaning" pairs. */
export function findDefinitions(text) {
  const defs = [];
  const seen = new Set();
  const add = (term, def, source) => {
    term = clean(term).replace(/^(the|a|an)\s+/i, '').replace(/[,;:]$/, '').trim();
    def = clean(def).replace(/\s*[;,]$/, '');
    if (!validTerm(term) || words(def).length < 3 || def.length > 320) return;
    const k = norm(term);
    if (seen.has(k)) return;
    seen.add(k);
    defs.push({ term, def: cap(def.replace(/\.$/, '')), source: source || `${term} — ${def}` });
  };
  // 1) "Term: definition" / "Term - definition" lines (very common in notes & glossaries)
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    const m = /^(?:[-*•]\s*|\d+[.)]\s*)?\**([A-Za-z][\w'’()\/ ,-]{1,58}?)\**\s*(?::|–|—|\s-\s)\s*(.{8,})$/.exec(l);
    if (m && words(m[1]).length <= 6 && !/https?$/i.test(m[1])) add(m[1], m[2], l);
  }
  // 2) "X is/are (a|an|the) Y", "X refers to Y", "X means Y", "X is defined as Y"
  const VERB = /^(.{2,60}?)\s+(is defined as|are defined as|refers to|refer to|is known as|means|is called|is|are)\s+((?:a|an|the|one|any|when|how|used|process|type|kind|form|measure|study|set|method|ability|state)\b.{8,})$/i;
  for (const s of splitSentences(text)) {
    let m = VERB.exec(s.replace(/[.!?]+$/, ''));
    if (m && !/,/.test(m[1])) { add(m[1], m[3], s); continue; }
    m = /^(.{12,220}?)\s+(?:is|are) called\s+(?:an?\s+|the\s+)?([\w\s'-]{2,40})$/i.exec(s.replace(/[.!?]+$/, ''));
    if (m) add(m[2], m[1], s);
  }
  return defs;
}

/** Ranked list of important terms (multi-word capitalised phrases, defined terms, frequent words). */
export function keyTerms(text, defs = findDefinitions(text)) {
  const score = new Map();
  const bump = (t, n) => { t = t.trim(); if (!validTerm(t)) return; score.set(t, (score.get(t) || 0) + n); };
  defs.forEach((d) => bump(d.term, 6));
  for (const s of splitSentences(text)) {
    // Capitalised phrases not at sentence start ("Krebs Cycle", "World War II")
    for (const m of s.matchAll(/\b([A-Z][a-z]+(?:\s+(?:of|and|the|de|von)?\s*[A-Z][a-zA-Z]+){0,3}|[A-Z]{2,6}s?)\b/g)) {
      const ph = m[1].replace(/^(The|A|An)\s+/, '');
      if (m.index === 0 && !m[1].includes(' ')) continue; // a capitalised first word is just grammar
      if (!STOP.has(ph.toLowerCase())) bump(ph, ph.includes(' ') ? 2 : 1);
    }
  }
  const freq = new Map();
  for (const w of text.toLowerCase().match(/\b[a-z][a-z-]{4,}\b/g) || []) if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  for (const [w, c] of freq) if (c >= 3) bump(w, c * 0.6);
  // collapse case-duplicates
  const merged = new Map();
  for (const [t, v] of score) { const k = norm(t); const cur = merged.get(k); if (!cur || v > cur.v) merged.set(k, { term: t, v: (cur?.v || 0) + v }); else cur.v += v; }
  const all = [...merged.values()].sort((a, b) => b.v - a.v).map((x) => x.term);
  return all.filter((t) => t !== t.toLowerCase() || t.includes(' ') || !all.some((o) => o !== t && o.toLowerCase().includes(t)));
}

function pickDistractors(answer, pool, n = 3) {
  const base = (x) => norm(x).replace(/^(the|a|an) /, '');
  const a = base(answer);
  const aw = words(answer).length;
  const isNum = /^\d/.test(answer);
  const seen = new Set([a]);
  const cands = pool.filter((p) => { const b = base(p); if (!b || seen.has(b) || b.includes(a) || a.includes(b)) return false; seen.add(b); return true; });
  // rank by how alike the candidate looks (number vs word, length, proper-name style)
  const isName = (x) => words(x).length > 1 && words(x).every((w) => /^[A-Z]/.test(w) || STOP.has(w));
  const score = (p) => (/^\d/.test(p) === isNum ? 3 : -5) + (Math.abs(words(p).length - aw) <= 1 ? 2 : 0) + (isName(p) === isName(answer) ? 2 : 0) + Math.random();
  return cands.map((p) => [score(p), p]).sort((x, y) => y[0] - x[0]).slice(0, n).map((x) => x[1]);
}

function numberVariant(n) {
  const v = Number(n.replace(/,/g, ''));
  if (!isFinite(v)) return null;
  const opts = /^1[0-9]{3}$|^20[0-9]{2}$/.test(n) ? [v - 10, v + 5, v - 3, v + 12] : [Math.round(v * 2), Math.round(v / 2) || v + 1, v + 1, v * 10];
  return String(shuffle(opts.filter((x) => x !== v && x > 0))[0] ?? v + 1);
}

/** Flashcards: term ↔ definition, plus fill-in-the-blank cards from key sentences. */
export function makeFlashcards(text, { max = 40 } = {}) {
  const defs = findDefinitions(text);
  const cards = defs.map((d) => ({ front: d.term, back: d.def }));
  const terms = keyTerms(text, defs).slice(0, 40);
  const used = new Set(cards.map((c) => norm(c.front)));
  for (const s of shuffle(splitSentences(text))) {
    if (cards.length >= max) break;
    const wc = words(s).length;
    if (wc < 7 || wc > 40 || PRONOUN_START.test(s)) continue;
    const t = terms.find((term) => !used.has(norm(term)) && new RegExp(`\\b${escRe(term)}\\b`, 'i').test(s));
    if (!t) continue;
    used.add(norm(t));
    cards.push({ front: s.replace(new RegExp(`\\b${escRe(t)}\\b`, 'i'), '_____'), back: t });
  }
  // Heading + bullet list → "List the key points of …"
  for (const m of text.matchAll(/^#{1,3}\s+(.+)\n+((?:\s*[-*•]\s+.+\n?){2,8})/gm)) {
    if (cards.length >= max) break;
    const pts = m[2].trim().split('\n').map((l) => clean(l)).filter(Boolean);
    cards.push({ front: `Key points: ${m[1].trim()}`, back: pts.map((p) => '• ' + p).join('\n') });
  }
  return cards.slice(0, max);
}

/**
 * Quiz / exam questions.
 * @param {string} text
 * @param {{count?: number, types?: string[]}} opts types ⊂ ['mcq','tf','fill','short']
 */
export function makeQuestions(text, { count = 15, types = ['mcq', 'tf', 'fill'] } = {}) {
  const defs = findDefinitions(text);
  const terms = keyTerms(text, defs);
  const termPool = [...new Set([...defs.map((d) => d.term), ...terms.slice(0, 60)])];
  const sentences = splitSentences(text).filter((s) => { const n = words(s).length; return n >= 6 && n <= 45 && !PRONOUN_START.test(s); });
  const buckets = { mcq: [], tf: [], fill: [], short: [] };

  // --- from definitions
  for (const d of shuffle(defs)) {
    const dis = pickDistractors(d.term, termPool);
    if (dis.length >= 2) {
      if (Math.random() < 0.5) buckets.mcq.push({ key: d.term, type: 'mcq', prompt: `Which term best matches this description?\n“${d.def}”`, options: shuffle([d.term, ...dis]), answer: d.term, explanation: d.source });
      else {
        const otherDefs = shuffle(defs.filter((x) => x !== d)).slice(0, 3).map((x) => x.def);
        if (otherDefs.length >= 2) buckets.mcq.push({ key: d.term, type: 'mcq', prompt: `What is “${d.term}”?`, options: shuffle([d.def, ...otherDefs]), answer: d.def, explanation: d.source });
      }
      const swap = dis[0];
      const truthy = Math.random() < 0.5;
      buckets.tf.push({ key: d.term, type: 'tf', prompt: `${cap(truthy ? d.term : swap)}: ${d.def}.`, options: ['True', 'False'], answer: truthy ? 'True' : 'False', explanation: truthy ? d.source : `This describes ${d.term}, not ${swap}.` });
    }
    buckets.fill.push({ key: d.term, type: 'fill', prompt: `${d.def}. This is called _____.`, answer: d.term, explanation: d.source });
    buckets.short.push({ key: d.term, type: 'short', prompt: `Define or explain: ${d.term}`, answer: d.def, explanation: d.source });
  }

  // --- from sentences containing key terms or numbers
  const usedS = new Set();
  const defSources = new Set(defs.map((d) => norm(d.source)));
  for (const s of shuffle(sentences)) {
    if (defSources.has(norm(s))) continue; // already covered by the definition questions
    if (usedS.size > count * 3) break;
    // prefer the longest matching term ("Napoleon Bonaparte" over "Bonaparte")
    const t = termPool.filter((term) => term.length > 2 && new RegExp(`\\b${escRe(term)}\\b`).test(s)).sort((x, y) => y.length - x.length)[0];
    const num = /\b(1[0-9]{3}|20[0-9]{2}|\d+(?:\.\d+)?%?)\b/.exec(s);
    if (t) {
      usedS.add(s);
      const blanked = s.replace(new RegExp(`\\b${escRe(t)}\\b`), '_____');
      const dis = pickDistractors(t, termPool);
      if (dis.length >= 2) buckets.mcq.push({ key: t, type: 'mcq', prompt: `Fill in the blank:\n${blanked}`, options: shuffle([t, ...dis]), answer: t, explanation: s });
      buckets.fill.push({ key: t, type: 'fill', prompt: blanked, answer: t, explanation: s });
      if (dis[0]) {
        const truthy = Math.random() < 0.5;
        buckets.tf.push({ key: t, type: 'tf', prompt: truthy ? s : s.replace(new RegExp(`\\b${escRe(t)}\\b`), dis[0]), options: ['True', 'False'], answer: truthy ? 'True' : 'False', explanation: s });
      }
    } else if (num) {
      usedS.add(s);
      const alt = numberVariant(num[1].replace('%', ''));
      if (alt) {
        const truthy = Math.random() < 0.5;
        const altTxt = alt + (num[1].endsWith('%') ? '%' : '');
        buckets.tf.push({ key: s, type: 'tf', prompt: truthy ? s : s.replace(num[1], altTxt), options: ['True', 'False'], answer: truthy ? 'True' : 'False', explanation: s });
        buckets.fill.push({ key: s, type: 'fill', prompt: s.replace(num[1], '_____'), answer: num[1], explanation: s });
      }
    }
  }

  // --- assemble: even mix of requested types, each concept asked once if possible
  const want = types.filter((t) => buckets[t]);
  for (const t of want) buckets[t] = shuffle(buckets[t]);
  const seenPrompt = new Set();
  const usedKeys = new Set();
  const out = [];
  for (const strict of [true, false]) {
    let stalled = 0;
    while (out.length < count && stalled < want.length) {
      const t = want[out.length % want.length];
      const b = buckets[t];
      let i = b.findIndex((q) => !seenPrompt.has(norm(q.prompt).slice(0, 80)) && (!strict || !usedKeys.has(norm(q.key || ''))));
      if (i < 0) {
        // this type is exhausted — borrow from another requested type
        const other = want.find((w) => buckets[w].some((q) => !seenPrompt.has(norm(q.prompt).slice(0, 80)) && (!strict || !usedKeys.has(norm(q.key || '')))));
        if (!other) { stalled = want.length; break; }
        const ob = buckets[other];
        i = ob.findIndex((q) => !seenPrompt.has(norm(q.prompt).slice(0, 80)) && (!strict || !usedKeys.has(norm(q.key || ''))));
        const [q] = ob.splice(i, 1);
        seenPrompt.add(norm(q.prompt).slice(0, 80)); usedKeys.add(norm(q.key || ''));
        const { key, ...rest } = q; out.push({ id: qid(), ...rest });
        continue;
      }
      const [q] = b.splice(i, 1);
      seenPrompt.add(norm(q.prompt).slice(0, 80)); usedKeys.add(norm(q.key || ''));
      const { key, ...rest } = q; out.push({ id: qid(), ...rest });
    }
  }
  return out;
}

/** Grades one answer. Returns true/false, or null for self-graded short answers. */
export function grade(q, given) {
  if (given == null || given === '') return false;
  if (q.type === 'short') return null;
  if (q.type === 'fill') {
    const a = norm(q.answer), g = norm(given);
    if (a === g) return true;
    return similarity(a, g) >= 0.82;
  }
  return given === q.answer;
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - m[a.length][b.length] / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------- auto-organising
const SUBJECTS = {
  Biology: 'cell cells organism dna rna protein enzyme photosynthesis mitosis meiosis gene genes species evolution ecosystem tissue membrane chromosome bacteria virus anatomy organ',
  Chemistry: 'atom atoms molecule molecules reaction compound element electron proton bond acid base ph solution mole periodic ion ionic covalent oxidation catalyst',
  Physics: 'force velocity acceleration energy momentum mass gravity newton wave frequency electric current voltage magnetic quantum thermodynamics friction',
  Mathematics: 'equation function derivative integral theorem algebra geometry matrix vector probability variable polynomial calculus graph proof angle triangle',
  History: 'war empire revolution century treaty king queen dynasty colonial independence president government ancient medieval battle republic',
  'Computer Science': 'algorithm data code program programming function variable array database network software compiler javascript python class object loop server',
  Economics: 'market demand supply price inflation gdp economy trade cost profit monetary fiscal interest tax consumer',
  Psychology: 'behavior behaviour cognitive memory perception emotion personality learning conditioning brain motivation stimulus',
  English: 'poem poetry novel character theme metaphor author narrative literary essay grammar verb noun sentence figurative',
  Business: 'management marketing strategy customer organization organisation finance accounting revenue brand stakeholder leadership',
  Nursing: 'patient nursing care medication assessment diagnosis symptoms dosage clinical vital blood pressure infection',
  Law: 'law court constitution rights contract legal statute liability plaintiff defendant jurisdiction',
};

export function detectSubject(text) {
  const w = (text.toLowerCase().match(/[a-z]+/g) || []);
  const bag = new Map();
  w.forEach((x) => bag.set(x, (bag.get(x) || 0) + 1));
  let best = null, bestScore = 0;
  for (const [subj, list] of Object.entries(SUBJECTS)) {
    const s = list.split(' ').reduce((n, k) => n + Math.min(bag.get(k) || 0, 5), 0);
    if (s > bestScore) { best = subj; bestScore = s; }
  }
  return bestScore >= 4 ? best : null;
}

export function autoTags(text, n = 4) {
  return keyTerms(text).filter((t) => words(t).length <= 2 && t.length <= 24).slice(0, n).map((t) => t.toLowerCase());
}

export function autoTitle(text, fallback = 'Untitled note') {
  const h = /^#{1,3}\s+(.{3,80})$/m.exec(text);
  if (h) return h[1].trim();
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 3);
  if (first && first.length <= 70 && !/[.!?]$/.test(first)) return first.replace(/^[-*•#\s]+/, '');
  return fallback;
}
