import { describe, expect, test } from 'vitest';
import { BASE16_SLOTS } from '../../theme/base16.ts';
import { SavedThemeSchemeSchema } from './saved-themes.ts';

function scheme(name: string, author?: string) {
  return {
    name,
    ...(author === undefined ? {} : { author }),
    variant: 'dark' as const,
    palette: Object.fromEntries(BASE16_SLOTS.map((slot) => [slot, '#123456'])),
  };
}

describe('SavedThemeSchemeSchema metadata', () => {
  test.each([
    ['name', scheme('\u0085', 'Ada')],
    ['author', scheme('Valid', '\u0085')],
  ])('rejects a U+0085 NEXT LINE-only %s', (_field, input) => {
    expect(SavedThemeSchemeSchema.safeParse(input).success).toBe(false);
  });

  test('preserves accepted boundary whitespace without transforming it', () => {
    const input = scheme('  Theme\t', '\n Ada \r');
    const parsed = SavedThemeSchemeSchema.safeParse(input);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBe(input.name);
    expect(parsed.data.author).toBe(input.author);
  });
});
