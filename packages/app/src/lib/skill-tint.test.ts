import {
  contrastRatio,
  MINIMUM_CONTRAST_RATIO,
  mixHex,
} from '@inkeep/open-knowledge-core/theme/base16';
import { THEME_PLUGINS } from '@inkeep/open-knowledge-core/theme/theme-plugins';
import { describe, expect, test } from 'vitest';
import { SKILL_TINTS } from './skill-tint';

const HEX = /^#[0-9a-f]{6}$/i;
const STOPS = /^from-([\w-]+)\/(\d+) to-([\w-]+)\/(\d+)$/;
const SAMPLES = 20;

const BUNDLED_THEMES = THEME_PLUGINS.flatMap((theme) =>
  theme.toTokens === undefined ? [] : [{ id: theme.id, tokens: theme.toTokens() }],
);

function tintStops(tint: string) {
  const stops = STOPS.exec(tint);
  if (stops === null) throw new Error(`unreadable tint: ${tint}`);
  const [, fromToken, fromAlpha, toToken, toAlpha] = stops;
  return {
    fromToken,
    fromAlpha: Number(fromAlpha) / 100,
    toToken,
    toAlpha: Number(toAlpha) / 100,
  };
}

describe('skill preview tint', () => {
  test('checks at least one bundled theme', () => {
    expect(BUNDLED_THEMES.length).toBeGreaterThan(0);
  });

  test.each(BUNDLED_THEMES)(
    `$id: full-strength foreground keeps ${MINIMUM_CONTRAST_RATIO.text}:1 on every tint`,
    ({ tokens }) => {
      const tints = SKILL_TINTS.map(tintStops);
      for (const token of [
        'background',
        'foreground',
        ...tints.flatMap((tint) => [tint.fromToken, tint.toToken]),
      ]) {
        expect(tokens[token], token).toMatch(HEX);
      }
      for (const { fromToken, fromAlpha, toToken, toAlpha } of tints) {
        for (let step = 0; step <= SAMPLES; step += 1) {
          const at = step / SAMPLES;
          const accent = mixHex(tokens[fromToken], tokens[toToken], at);
          const wash = mixHex(tokens.background, accent, fromAlpha + (toAlpha - fromAlpha) * at);
          expect(
            contrastRatio(tokens.foreground, wash),
            `from-${fromToken} to-${toToken} at ${at.toFixed(2)}`,
          ).toBeGreaterThanOrEqual(MINIMUM_CONTRAST_RATIO.text);
        }
      }
    },
  );
});
