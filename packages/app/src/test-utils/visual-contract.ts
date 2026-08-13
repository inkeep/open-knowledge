import { expect } from 'vitest';

// Visual contract guard: jsdom exposes Tailwind tokens only as class strings,
// so use this helper only for CSS behavior jsdom cannot execute directly.
type ClassNameValue = string | null | undefined;

/**
 * Whitespace-split, because a class list is a SET of tokens and not a string to
 * search. Substring matching quietly reads a token as present whenever it is
 * spelled inside a longer one — `h-12` inside `min-h-12`, `w-4` inside `w-40`,
 * `border` inside `border-t` — which turns an absence contract into an
 * assertion that no class merely CONTAINS those characters. A shared floor
 * added to a base component then fails a test about a variant's own sizing.
 *
 * Expected entries are split the same way, so a caller may pass several tokens
 * as one string and have each checked in its own right.
 */
function classTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0);
}

export function expectVisualClassTokens(className: ClassNameValue, tokens: readonly string[]) {
  const actualTokens = classTokens(className ?? '');

  for (const entry of tokens) {
    for (const token of classTokens(entry)) {
      expect(actualTokens).toContain(token);
    }
  }
}

export function expectVisualClassTokensAbsent(
  className: ClassNameValue,
  tokens: readonly string[],
) {
  const actualTokens = classTokens(className ?? '');

  for (const entry of tokens) {
    for (const token of classTokens(entry)) {
      expect(actualTokens).not.toContain(token);
    }
  }
}
