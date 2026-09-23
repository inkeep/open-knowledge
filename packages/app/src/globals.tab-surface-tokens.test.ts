import { describe, expect, test } from 'vitest';
import { readGlobalsCssWithoutComments } from './globals-css.test-helper';

const CSS = readGlobalsCssWithoutComments();

const TAB_SURFACE_UTILITIES = [
  'sidebar-hover',
  'sidebar-hover-foreground',
  'sidebar-hover-muted-foreground',
  'sidebar-selected',
  'sidebar-selected-foreground',
] as const;

function themeInlineBlock(): string {
  const start = CSS.indexOf('@theme inline');
  if (start === -1) return '';
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i);
  }
  return '';
}

const THEME_INLINE = themeInlineBlock();

function themeAlias(token: string): string | null {
  const match = THEME_INLINE.match(new RegExp(`--color-${token}\\s*:\\s*var\\(--${token}\\)`));
  return match?.[0] ?? null;
}

describe('globals.css — tab surface tokens', () => {
  test('the @theme inline block is found, so the assertions below are not vacuous', () => {
    expect(THEME_INLINE.length, '@theme inline block not located in globals.css').toBeGreaterThan(
      0,
    );
    expect(THEME_INLINE).toMatch(/--color-sidebar\s*:\s*var\(--sidebar\)/);
  });

  test.each(TAB_SURFACE_UTILITIES)(
    'registers --color-%s, without which Tailwind emits no utility for it',
    (token) => {
      expect(
        themeAlias(token),
        `--color-${token} is unregistered, so text-/bg-${token} produces no CSS rule and the element falls back through the cascade`,
      ).not.toBeNull();
    },
  );
});
