// Detects quizzes / reviewers / question banks that are ALREADY in a file and
// extracts them exactly as written (question text, choices, answer key) instead
// of generating new questions.
//
// Handles common layouts:
//   1. Question text …            Q1) …           1) …
//      a. choice   b) choice   (C) choice   A. choice   (several choices may share a line)
//      Answer: B   /  Ans: b. text  /  Correct answer: True   /  *marked choice
//   …and an answer key at the end:  "Answer key  1. B  2. C  3. True  4. mitochondria"

const Q_START = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):\]]\s*(.*)$/i;
const OPT = /^\s*[([]?([a-hA-H])[.)\]]\s+(.+)$/;
const INLINE_OPTS = /(?:^|\s{1,})[([]?([a-hA-H])[.)\]]\s+/g;
const ANS_LINE = /^\s*(?:correct\s+answer|answer|ans|key|rationale)\s*[:.\-–]\s*(.+)$/i;
const KEY_HEADER = /^\s*(answer\s*key|answers?|key\s+to\s+correction|answer\s+sheet|correct\s+answers?)\s*:?\s*$/i;
const MARKED = /^\s*(?:\*|✓|✔|\(correct\)|\[x\])\s*|\s*(?:\*|✓|✔|\(correct\)|\[x\])\s*$/i;

const clean = (s) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const ROMAN = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)[.)]\s+/;
const FORM = /^(?:\s*(?:name|school|batch|score|date|section|course|year|student|id|instructor|teacher|class|group)\s*:?\s*_{2,}\s*)+$|^[_\s.:-]{4,}$/i;
const NOISE = /^(directions?|instructions?|part\s+[ivx\d]+|test\s+[ivx\d]+|section\s+[ivx\d]+)\b/i;
const isTF = (s) => /^(t|f|true|false|tama|mali)$/i.test(String(s).trim());
const tfNorm = (s) => (/^(t|true|tama)$/i.test(String(s).trim()) ? 'True' : 'False');

function splitOptionsOnLine(line) {
  // "a. Flexion b. Extension c. Abduction" → three options
  const marks = [...line.matchAll(INLINE_OPTS)];
  if (marks.length < 2) return null;
  const letters = marks.map((m) => m[1].toLowerCase());
  // must be consecutive letters starting at a/A (avoid splitting normal sentences)
  if (letters.some((l, i) => l.charCodeAt(0) !== letters[0].charCodeAt(0) + i)) return null;
  return marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
    return { letter: m[1].toLowerCase(), text: clean(line.slice(start, end)) };
  });
}

function parseKey(lines) {
  // "1. B", "1) b", "1 - True", "1. B 2. C 3. A" (several per line), "1.B"
  const key = new Map();
  for (const line of lines) {
    for (const m of line.matchAll(/(\d{1,3})\s*[.):\-–]\s*([A-Ha-h](?![a-z])|true|false|[^\d\s][^\n]*?)(?=\s+\d{1,3}\s*[.):\-–]|\s*$)/gi)) {
      const v = clean(m[2]);
      if (v) key.set(Number(m[1]), v);
    }
  }
  return key;
}

/**
 * @returns {{questions: Array, total: number, missing: number} | null}
 *   null when the text doesn't look like an existing quiz.
 */
export function extractExistingQuestions(rawText) {
  const text = String(rawText || '').replace(/\f/g, '\n').replace(/\r\n?/g, '\n');
  let lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));

  // separate an answer-key section at the end, if any
  let key = new Map();
  const keyIdx = lines.findIndex((l, i) => KEY_HEADER.test(l) && i > lines.length * 0.3);
  if (keyIdx > -1) { key = parseKey(lines.slice(keyIdx + 1)); lines = lines.slice(0, keyIdx); }

  const blocks = [];
  let cur = null, expect = 1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || FORM.test(line) || NOISE.test(line)) continue;
    const qm = Q_START.exec(line);
    // a new question must continue the numbering (allows restarts at 1 for new parts)
    if (qm && (Number(qm[1]) === expect || Number(qm[1]) === 1 || (cur && Number(qm[1]) === cur.n + 1))) {
      if (!(cur && !cur.opts.length && !cur.q && qm[2] === '')) {
        cur = { n: Number(qm[1]), q: qm[2], opts: [], answer: null, explanation: null };
        blocks.push(cur); expect = cur.n + 1;
        continue;
      }
    }
    if (!cur) continue;
    const am = ANS_LINE.exec(line);
    if (am) {
      if (/^rationale/i.test(line)) cur.explanation = clean(am[1]); else cur.answer = clean(am[1]);
      continue;
    }
    const multi = splitOptionsOnLine(line);
    if (multi && (cur.opts.length === 0 || multi[0].letter.charCodeAt(0) === cur.opts[cur.opts.length - 1].letter.charCodeAt(0) + 1)) {
      cur.opts.push(...multi); continue;
    }
    const om = OPT.exec(line);
    const nextLetter = String.fromCharCode(97 + cur.opts.length);
    if (om && om[1].toLowerCase() === nextLetter) { cur.opts.push({ letter: om[1].toLowerCase(), text: clean(om[2]) }); continue; }
    // a short ALL-CAPS line after the choices is a heading/title, not part of the answer
    if (cur.opts.length && /^[^a-z]{3,60}$/.test(line) && /[A-Z]{3}/.test(line) && line.split(/\s+/).length <= 8 && !/[.?]$/.test(line)) continue;
    // continuation of the question or of the last option; I./II./III. statements keep their own lines
    if (cur.opts.length) cur.opts[cur.opts.length - 1].text = clean(`${cur.opts[cur.opts.length - 1].text} ${line}`);
    else cur.q = ROMAN.test(line) ? `${cur.q}\n${line}` : clean(`${cur.q} ${line}`);
  }

  // turn blocks into questions
  const out = [];
  let missing = 0;
  for (const b of blocks) {
    const prompt = clean(b.q);
    if (!prompt) continue;
    // options marked with * / ✓ are the answer
    let marked = null;
    b.opts.forEach((o) => { if (MARKED.test(o.text)) { marked = o; o.text = clean(o.text.replace(MARKED, '')); } });
    const raw = b.answer ?? key.get(b.n) ?? marked?.letter ?? null;
    let q;
    if (b.opts.length >= 2) {
      const opts = b.opts.map((o) => o.text);
      if (opts.length === 2 && opts.every(isTF)) {
        q = { type: 'tf', prompt, options: ['True', 'False'], answer: raw ? tfNorm(resolveLetter(raw, b.opts) || raw) : null };
      } else {
        const a = raw ? resolveLetter(raw, b.opts) : null;
        q = { type: 'mcq', prompt, options: opts, answer: a && opts.includes(a) ? a : null }; // unmatched key → ask the user
      }
    } else if (raw && isTF(raw)) {
      q = { type: 'tf', prompt, options: ['True', 'False'], answer: tfNorm(raw) };
    } else if (raw) {
      q = { type: raw.split(/\s+/).length <= 6 ? 'fill' : 'short', prompt, answer: raw };
    } else if (/_{3,}|\.{4,}/.test(prompt) || /\?$/.test(prompt)) {
      q = { type: 'fill', prompt, answer: null };
    } else {
      q = { type: 'fill', prompt, answer: null, weak: true }; // only kept if the file is clearly a quiz
    }
    if (b.explanation) q.explanation = b.explanation;
    q.number = b.n;
    out.push(q);
  }

  // only treat it as a quiz if it really looks like one
  const strong = out.filter((q) => !q.weak);
  const qLike = strong.filter((q) => q.options || q.answer != null || /\?$|_{3,}/.test(q.prompt)).length;
  if (strong.length < 3 || qLike < Math.max(3, out.length * 0.5)) return null;
  out.forEach((q) => delete q.weak);
  const withChoices = out.filter((q) => q.type === 'mcq' || q.type === 'tf').length;
  if (withChoices < 2 && key.size < 3 && out.filter((q) => q.answer != null).length < 3) return null;
  missing = out.filter((q) => q.answer == null).length;
  return { questions: out.map((q, i) => ({ id: `f${Date.now().toString(36)}${i}`, ...q })), total: out.length, missing };
}

function resolveLetter(raw, opts) {
  const s = clean(String(raw));
  const low = s.toLowerCase();
  // answer written out in full
  const full = opts.find((o) => o.text.toLowerCase() === low);
  if (full) return full.text;
  // "B", "b.", "(b)", "B. Closed chain", "letter B"
  const m = /^(?:letter\s+)?[([]?([a-hA-H])(?:[.)\]]|\s|$)/.exec(s);
  if (m) { const o = opts.find((x) => x.letter === m[1].toLowerCase()); if (o) return o.text; }
  const hit = opts.find((o) => o.text.toLowerCase().startsWith(low) || low.startsWith(o.text.toLowerCase()));
  return hit ? hit.text : s;
}

/**
 * Applies a typed/pasted answer key to questions.
 * Accepts "1.B 2.C 3.True 4. mitochondria", one per line, or just letters in order ("BCADA" / "B C A D").
 * Returns how many answers were set.
 */
export function applyAnswerKey(questions, text) {
  const src = String(text || '').trim();
  if (!src) return 0;
  const byNum = new Map();
  if (/\d\s*[.):\-–]/.test(src)) {
    for (const m of src.matchAll(/(\d{1,3})\s*[.):\-–]\s*([A-Ha-h](?![a-z])|true|false|[^\d\n]+?)(?=\s*[,;]?\s*\d{1,3}\s*[.):\-–]|\s*$|\n)/gi)) byNum.set(Number(m[1]), m[2].trim().replace(/[,;]$/, ''));
  } else {
    const tokens = /\s|,/.test(src) ? src.split(/[\s,;]+/).filter(Boolean) : src.split('');
    tokens.forEach((t, i) => byNum.set(i + 1, t));
  }
  let set = 0;
  questions.forEach((q, i) => {
    const raw = byNum.get(q.number ?? i + 1) ?? (q.number ? null : null);
    if (raw == null || raw === '') return;
    if (q.type === 'mcq') {
      const opts = (q.options || []).map((o, k) => ({ letter: 'abcdefgh'[k], text: o }));
      const a = resolveLetter(raw, opts);
      if (!(q.options || []).includes(a)) return;
      q.answer = a;
    } else if (q.type === 'tf') q.answer = tfNorm(raw);
    else q.answer = raw;
    set++;
  });
  return set;
}
