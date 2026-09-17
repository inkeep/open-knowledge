import { describe, expect, test } from 'vitest';
import {
  CODEX_CONFIG_ENV,
  contextChoicesFor,
  effectiveContextTokens,
  parseCodexConfigEnv,
  withCodexContextWindow,
} from './codex-context.ts';

const sol = { maxContextWindow: 872_000, effectivePercent: 95 };
const gpt55 = { maxContextWindow: 272_000, effectivePercent: 95 };

describe('the window Codex actually grants', () => {
  test('a request under the ceiling is reduced only by the effective factor', () => {
    expect(effectiveContextTokens(500_000, sol)).toBe(475_000);
  });

  test('a request over the ceiling is clamped first, then reduced', () => {
    expect(effectiveContextTokens(9_999_999, sol)).toBe(828_400);
  });

  test('the ceiling follows the selected model, not the one the session started on', () => {
    expect(effectiveContextTokens(9_999_999, gpt55)).toBe(258_400);
  });

  test('an absent ceiling grants what was asked for', () => {
    expect(effectiveContextTokens(300_000, { maxContextWindow: null, effectivePercent: 95 })).toBe(
      285_000,
    );
  });

  test('a missing factor falls back to the observed 95 percent', () => {
    expect(
      effectiveContextTokens(500_000, { maxContextWindow: 872_000, effectivePercent: null }),
    ).toBe(475_000);
  });

  test('a nonsense request grants nothing rather than a negative window', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveContextTokens(bad, sol)).toBe(0);
    }
  });
});

describe('what a model offers to choose between', () => {
  test('a model whose default is below its ceiling offers both', () => {
    expect(
      contextChoicesFor({
        slug: 'sol',
        contextWindow: 256_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      }),
    ).toEqual([256_000, 872_000]);
  });

  test('a model with one usable size offers exactly that one', () => {
    expect(
      contextChoicesFor({
        slug: 'x',
        contextWindow: 272_000,
        maxContextWindow: 272_000,
        effectivePercent: 95,
      }),
    ).toEqual([272_000]);
  });

  test('a catalog row carrying no sizes offers none rather than inventing one', () => {
    expect(
      contextChoicesFor({
        slug: 'x',
        contextWindow: null,
        maxContextWindow: null,
        effectivePercent: 95,
      }),
    ).toEqual([]);
  });
});

describe('the config the adapter reads at startup', () => {
  test('the requested window rides in CODEX_CONFIG', () => {
    const env = withCodexContextWindow({ PATH: '/usr/bin' }, 500_000);
    expect(JSON.parse(env[CODEX_CONFIG_ENV] as string)).toEqual({ model_context_window: 500_000 });
    expect(env.PATH).toBe('/usr/bin');
  });

  test('an existing config keeps its other keys', () => {
    const env = withCodexContextWindow(
      { [CODEX_CONFIG_ENV]: '{"model":"gpt-5.6-sol","sandbox_mode":"read-only"}' },
      500_000,
    );
    expect(JSON.parse(env[CODEX_CONFIG_ENV] as string)).toEqual({
      model: 'gpt-5.6-sol',
      sandbox_mode: 'read-only',
      model_context_window: 500_000,
    });
  });

  test('no choice leaves the environment untouched', () => {
    const env = { [CODEX_CONFIG_ENV]: '{"model":"gpt-5.6-sol"}' };
    expect(withCodexContextWindow(env, null)).toBe(env);
    expect(withCodexContextWindow(env, 0)).toBe(env);
  });

  test('a corrupt existing config is replaced rather than propagated', () => {
    const env = withCodexContextWindow({ [CODEX_CONFIG_ENV]: 'not json' }, 400_000);
    expect(JSON.parse(env[CODEX_CONFIG_ENV] as string)).toEqual({ model_context_window: 400_000 });
  });

  test('parsing tolerates every shape that is not an object', () => {
    for (const raw of [undefined, '', '   ', 'null', '[]', '"str"', '7']) {
      expect(parseCodexConfigEnv(raw)).toEqual({});
    }
  });
});
