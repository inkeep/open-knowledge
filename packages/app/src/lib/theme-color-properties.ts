import { base16ToTokens, PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import { DEFAULT_CUSTOM_SCHEME } from './color-themes';

const PALETTE_THEME_COLOR_PROPERTIES = Object.keys(base16ToTokens(DEFAULT_CUSTOM_SCHEME)).map(
  (name) => `--${name}`,
);

export const THEME_COLOR_PROPERTIES: readonly string[] = [
  ...new Set([
    ...PREVIEW_THEME_TOKENS.filter((token) => token.name !== '--radius').map((token) => token.name),
    ...PALETTE_THEME_COLOR_PROPERTIES,
    '--ok-comment-hue',
  ]),
];

const themeColorPropertySet = new Set(THEME_COLOR_PROPERTIES);

export function isThemeColorProperty(name: string): boolean {
  return themeColorPropertySet.has(name);
}
