/**
 * Pure heuristic-warning detector for `.okignore` pattern lines.
 *
 * Why heuristics, not validation: per `npm:ignore`'s actual behavior
 * and git's gitignore spec, almost no syntactic input throws — most
 * "wrong-looking" patterns simply match nothing. Server-side persistence
 * rejection only fires on whitespace-only lines (the structural
 * "user committed nothing" case). These five shapes are commit-but-
 * probably-not-what-you-meant signals surfaced as yellow non-blocking
 * indicators in the list editor.
 *
 * Browser-safe, no dependencies. Tested in `okignore-warnings.test.ts`.
 */

type OkignoreWarningCode =
  | 'trailing-backslash'
  | 'unmatched-bracket'
  | 'lone-bang'
  | 'leading-whitespace'
  | 'embedded-newline';

export interface OkignoreWarning {
  readonly code: OkignoreWarningCode;
  readonly message: string;
}

export const WARNING_MESSAGES: Readonly<Record<OkignoreWarningCode, string>> = {
  'trailing-backslash': "Trailing backslash — line continuation isn't supported.",
  'unmatched-bracket': 'Unmatched [ — character class is open.',
  'lone-bang': 'Lone ! — negation needs a pattern after it.',
  'leading-whitespace': 'Leading whitespace — the rule may not match as expected.',
  'embedded-newline': 'Embedded line break — the row spans multiple lines.',
};

/**
 * Inspect a single pattern line and return any heuristic warnings.
 * Empty lines and `#`-comments return `[]` — they're metadata, not
 * patterns the user committed by intent.
 *
 * The returned array is fresh per call; safe to use as React state
 * without aliasing the caller's reference.
 */
export function checkHeuristicWarnings(line: string): OkignoreWarning[] {
  const warnings: OkignoreWarning[] = [];
  if (line.length === 0) return warnings;
  // Comment lines never get warnings — they round-trip as metadata.
  if (line.trimStart().startsWith('#')) return warnings;

  if (/[\r\n]/.test(line)) {
    warnings.push({ code: 'embedded-newline', message: WARNING_MESSAGES['embedded-newline'] });
  }
  if (/^\s/.test(line)) {
    warnings.push({ code: 'leading-whitespace', message: WARNING_MESSAGES['leading-whitespace'] });
  }

  const trimmed = line.trim();
  if (trimmed === '!') {
    warnings.push({ code: 'lone-bang', message: WARNING_MESSAGES['lone-bang'] });
  }
  if (trimmed.endsWith('\\')) {
    warnings.push({
      code: 'trailing-backslash',
      message: WARNING_MESSAGES['trailing-backslash'],
    });
  }

  // Count `[` vs `]`. Open > close is "open character class" — gitignore
  // treats this as a literal class extending to EOL which never matches.
  // Close > open is fine (gitignore tolerates a stray `]`).
  const opens = countMatches(trimmed, '[');
  const closes = countMatches(trimmed, ']');
  if (opens > closes) {
    warnings.push({ code: 'unmatched-bracket', message: WARNING_MESSAGES['unmatched-bracket'] });
  }

  return warnings;
}

function countMatches(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}
