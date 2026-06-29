export const MAX_SUMMARY_LENGTH = 80;

const ELLIPSIS = '…';

// biome-ignore lint/complexity/useRegexLiterals: see docblock above for the constraint that forces `new RegExp`.
const LINE_TERMINATOR_RE = new RegExp('[\\r\\n\\v\\f\\u0085\\u2028\\u2029]', 'g');

export type NormalizedSummary =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: string; truncatedFrom?: number };

export function normalizeSummary(raw: unknown): NormalizedSummary {
  if (raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'invalid' };
  if (raw.length === 0 || raw.trim().length === 0) return { kind: 'absent' };
  const sanitized = raw.replace(LINE_TERMINATOR_RE, ' ');
  if (sanitized.length <= MAX_SUMMARY_LENGTH) {
    return { kind: 'value', value: sanitized };
  }
  return {
    kind: 'value',
    value: sanitized.slice(0, MAX_SUMMARY_LENGTH - 1) + ELLIPSIS,
    truncatedFrom: raw.length,
  };
}
