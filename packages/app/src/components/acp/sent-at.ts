/**
 * When a sent message was sent, as a stamp that reads the same every time you
 * look at it. An age ("20m") answers how long ago and nothing else: two
 * messages from the same sitting both read "20m", and the string silently
 * changes under a transcript left open overnight.
 *
 * Only as much date as the reader doesn't already have. Today's turns show the
 * time alone; the last week gets a weekday, which is how people refer to recent
 * work out loud; older turns need the calendar date, and the year only once
 * outside this one.
 *
 * Rendered in the machine's own timezone. The LOCALE is the app's, not the
 * OS's: interface language is independently selectable here, and the weekday
 * branch is the exposed case — a full English "Wednesday" beside Arabic copy
 * is what `BugReportHistory` already carries a regression test to prevent.
 * (`ThreadCard`'s comment stamp still formats against the OS locale; the two
 * disagree, so don't read either as the house rule.)
 */

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
  // Bounded on BOTH sides: a clock skew or a replayed log can stamp a turn in
  // the future, and "Wednesday 6:48 PM" for something not yet sent reads as a
  // date the reader already missed.
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
