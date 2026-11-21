// OPTIONAL AI generator (Vercel serverless function).
// Only active when ANTHROPIC_API_KEY is set in Vercel → Project → Settings →
// Environment Variables. Without it the app uses its built-in offline generator.
// Only signed-in StudyDeck users can call it (their Supabase token is checked).
// Nothing is stored here: text comes in, questions go back out.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://agynnezilmopxxzkqrzt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_MdIa5pFhTjVPkdaTT-iVCw_hppmmnKs';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_CHARS = 60000;

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ enabled: Boolean(process.env.ANTHROPIC_API_KEY) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ error: 'AI generation is not configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in to use AI generation' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return res.status(401).json({ error: 'Session expired — sign in again' });

  const { text = '', kind = 'quiz', count = 15, types = ['mcq', 'tf', 'fill'] } = req.body || {};
  const n = Math.max(1, Math.min(Number(count) || 15, 40)); // the app sends big sets (up to 200) in batches of 40
  const source = String(text).slice(0, MAX_CHARS);
  if (source.trim().length < 80) return res.status(400).json({ error: 'Not enough text to work from' });

  const schema = kind === 'cards'
    ? `{"cards":[{"front":"term or question","back":"answer or definition"}]}`
    : `{"questions":[{"type":"mcq|tf|fill|short","prompt":"...","options":["only for mcq (4 options) and tf (True, False)"],"answer":"exact correct option text, or the expected answer","explanation":"one sentence citing the material"}]}`;
  const instructions = kind === 'cards'
    ? `Write ${n} high-quality study flashcards covering the most important ideas, terms, facts and relationships in the material.`
    : `Write ${n} ${kind === 'exam' ? 'exam' : 'quiz'} questions that test understanding of the material, not trivia. Use only these types: ${types.join(', ')}. Mix difficulty. For "fill" use _____ for the blank and a short answer. For "short" give a model answer of 1-3 sentences.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: 'You create study material for students strictly from the provided text. Reply with JSON only, no prose, no code fences.',
      messages: [{ role: 'user', content: `${instructions}\nReturn exactly this JSON shape: ${schema}\n\n<material>\n${source}\n</material>` }],
    }),
  });
  if (!r.ok) return res.status(502).json({ error: `AI request failed (${r.status})` });
  const data = await r.json();
  const raw = (data.content || []).map((c) => c.text || '').join('');
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return res.status(200).json(json);
  } catch {
    return res.status(502).json({ error: 'AI returned an unreadable answer, try again' });
  }
}
