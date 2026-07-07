import { expect } from 'bun:test';

// Visual contract guard: jsdom exposes Tailwind tokens only as class strings,
// so use this helper only for CSS behavior jsdom cannot execute directly.
type ClassNameValue = string | null | undefined;

export function expectVisualClassTokens(className: ClassNameValue, tokens: readonly string[]) {
  const actualClassName = className ?? '';

  for (const token of tokens) {
    expect(actualClassName).toContain(token);
  }
}

export function expectVisualClassTokensAbsent(
  className: ClassNameValue,
  tokens: readonly string[],
) {
  const actualClassName = className ?? '';

  for (const token of tokens) {
    expect(actualClassName).not.toContain(token);
  }
}
