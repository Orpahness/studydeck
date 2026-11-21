// Spaced repetition (a simplified SM-2). Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy.
const DAY = 86400000;

export function schedule(card, rating) {
  let { ease = 2.5, interval_days: iv = 0, reps = 0, lapses = 0 } = card;
  if (rating === 1) {
    lapses += 1; reps = 0; iv = 0; ease = Math.max(1.3, ease - 0.2);
    return { ease, interval_days: 0, reps, lapses, due_at: new Date(Date.now() + 10 * 60000).toISOString(), last_reviewed_at: new Date().toISOString() };
  }
  if (reps === 0) iv = rating === 2 ? 0.5 : rating === 3 ? 1 : 3;
  else if (reps === 1) iv = rating === 2 ? 2 : rating === 3 ? 3 : 6;
  else iv = iv * (rating === 2 ? 1.2 : rating === 3 ? ease : ease * 1.3);
  ease = Math.max(1.3, ease + (rating === 2 ? -0.15 : rating === 4 ? 0.15 : 0));
  reps += 1;
  iv = Math.min(365, Math.round(iv * 10) / 10);
  return { ease, interval_days: iv, reps, lapses, due_at: new Date(Date.now() + iv * DAY).toISOString(), last_reviewed_at: new Date().toISOString() };
}

export function preview(card, rating) {
  const s = schedule(card, rating);
  const d = s.interval_days;
  if (rating === 1) return '10m';
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return '1y';
}

export const isDue = (c) => new Date(c.due_at) <= new Date();
export const isMastered = (c) => (c.interval_days || 0) >= 21;
export function cardStatus(c) {
  if (!c.reps && !c.last_reviewed_at) return 'new';
  if (isMastered(c)) return 'mastered';
  return 'learning';
}
