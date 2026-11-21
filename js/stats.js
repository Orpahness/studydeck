import { db } from './store.js';
import { dayKey, pct } from './util.js';
import { isDue, isMastered } from './srs.js';

export async function loadStats() {
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const [cards, logs, attempts] = await Promise.all([
    db.list('cards', { select: 'id,deck_id,due_at,interval_days,reps,last_reviewed_at' }),
    db.list('study_logs', { select: 'id,created_at,rating,deck_id', order: 'created_at', desc: true }),
    db.list('quiz_attempts', { select: 'id,quiz_id,score,total,created_at,duration_s', order: 'created_at', desc: true }),
  ]);
  const recentLogs = logs.filter((l) => l.created_at >= since);
  const activeDays = new Set([...logs.map((l) => dayKey(l.created_at)), ...attempts.map((a) => dayKey(a.created_at))]);
  let streak = 0;
  const d = new Date();
  if (!activeDays.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not done yet doesn't break the streak
  while (activeDays.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  const today = dayKey(new Date());
  const reviewedToday = logs.filter((l) => dayKey(l.created_at) === today).length;
  const avgScore = attempts.length ? Math.round(attempts.slice(0, 20).reduce((s, a) => s + pct(a.score, a.total), 0) / Math.min(20, attempts.length)) : null;
  return {
    cards, logs: recentLogs, attempts, streak, reviewedToday, avgScore,
    due: cards.filter(isDue).length,
    mastered: cards.filter(isMastered).length,
    retention: recentLogs.length ? pct(recentLogs.filter((l) => l.rating >= 3).length, recentLogs.length) : null,
  };
}

/** Activity (reviews + quiz questions answered) per day for the last `days` days. */
export function dailyActivity(stats, days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    const v = stats.logs.filter((l) => dayKey(l.created_at) === k).length + stats.attempts.filter((a) => dayKey(a.created_at) === k).reduce((s, a) => s + a.total, 0);
    out.push({ label: days <= 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value: v });
  }
  return out;
}
