import { expect } from 'vitest';

type ClassNameValue = string | null | undefined;

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
