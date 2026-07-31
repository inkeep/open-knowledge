/**
 * Live-token forwarding for the preview iframe.
 *
 * A preview runs at a null origin and inherits nothing from the host, so its
 * tokens are baked into the `srcDoc` and pushed over `postMessage`. The baked
 * set describes the DEFAULT theme only; these tests pin when the host's live
 * values override it and — load-bearing — when they must NOT, because a live
 * override is mode-agnostic and would pin an embed to whichever mode was
 * active at mount.
 *
 * The host is injected rather than stood up as a DOM, matching the
 * `computeLiveXtermTheme` reader seam.
 */

import { describe, expect, test } from 'vitest';
import { buildPreviewIframeHeader, buildPreviewThemeMessage } from './preview-iframe-header';
import { type PreviewTokenEnv, readLivePreviewTokens } from './preview-live-tokens';

/** A host with a palette selected, resolving the given tokens and nothing else. */
function withPalette(tokens: Record<string, string>): PreviewTokenEnv {
  return { paletteActive: true, readToken: (name) => tokens[name] ?? null };
}

/** A host on the default theme — no palette, so nothing should be forwarded. */
const NO_PALETTE: PreviewTokenEnv = { paletteActive: false, readToken: () => null };

describe('readLivePreviewTokens', () => {
  test('returns an empty map when no color theme is selected', () => {
    expect(readLivePreviewTokens(NO_PALETTE)).toEqual({});
  });

  test('returns null when there is no host to read', () => {
    expect(readLivePreviewTokens(null)).toBeNull();
  });

  test('forwards the host values once a palette is selected', () => {
    const tokens = readLivePreviewTokens(
      withPalette({ '--primary': '#bd93f9', '--background': '#282a36' }),
    );
    expect(tokens?.['--primary']).toBe('#bd93f9');
    expect(tokens?.['--background']).toBe('#282a36');
  });

  test('forwards tokens beyond the baked snapshot set', () => {
    // The snapshot covers charts and the core surface pair; an embed reaching
    // for a syntax color has nothing to bind to without these.
    const tokens = readLivePreviewTokens(withPalette({ '--syntax-string': '#50fa7b' }));
    expect(tokens?.['--syntax-string']).toBe('#50fa7b');
  });

  test('drops a value that still carries var() indirection', () => {
    // Unresolved inside the null-origin frame, where the chain does not exist.
    const tokens = readLivePreviewTokens(withPalette({ '--primary': 'var(--color-sky-blue)' }));
    expect(tokens?.['--primary']).toBeUndefined();
  });
});

describe('srcDoc live-override block', () => {
  test('is absent under the default theme, leaving the baked light/dark blocks in charge', () => {
    const header = buildPreviewIframeHeader('light', NO_PALETTE);
    expect(header).toContain(':root{');
    expect(header).toContain(':root.dark{');
    expect(header).not.toContain(':root,:root.dark{');
  });

  test('matches both roots when a palette is selected, so it beats the baked dark block', () => {
    const header = buildPreviewIframeHeader('dark', withPalette({ '--background': '#282a36' }));
    // Equal specificity to `:root.dark` and later in source order — the only
    // shape that wins in both modes.
    expect(header).toContain(':root,:root.dark{');
    expect(header).toContain('--background:#282a36');
  });
});

describe('buildPreviewThemeMessage', () => {
  test('carries the palette tokens so a live iframe re-skins without a reload', () => {
    const message = buildPreviewThemeMessage('dark', withPalette({ '--primary': '#bd93f9' })) as
      | Record<string, unknown>
      | undefined;
    expect(message?.okPreviewTheme).toBe('dark');
    expect((message?.okPreviewTokens as Record<string, string>)['--primary']).toBe('#bd93f9');
  });

  test('carries an empty token map under the default theme', () => {
    // Empty rather than absent: the iframe bootstrap uses the payload to REMOVE
    // properties a previously-selected palette set, so switching back to
    // `default` can't strand them as inline overrides.
    const message = buildPreviewThemeMessage('light', NO_PALETTE) as Record<string, unknown>;
    expect(message.okPreviewTokens).toEqual({});
  });
});
