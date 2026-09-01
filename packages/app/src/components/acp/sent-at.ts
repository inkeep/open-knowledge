const WEEKDAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function formatSentAt(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return date.toLocaleTimeString(locale, time);
  const age = now - at;
  if (age > 0 && age < WEEKDAY_WINDOW_MS) {
    return date.toLocaleString(locale, { weekday: 'long', ...time });
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleString(locale, { month: 'short', day: 'numeric', ...time });
  }
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...time,
  });
}
