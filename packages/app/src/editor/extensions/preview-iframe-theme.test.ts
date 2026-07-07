/**
 * Theme-injection guard for the preview iframe header.
 *
 * `buildPreviewIframeHeader` injects OK's design tokens (both themes), a
 * `color-scheme` declaration, themed `body` defaults, and a `postMessage`
 * bootstrap script into every preview `srcDoc` — the mechanism that lets
 * embedded `html preview` content track the reader's light/dark theme and
 * report its rendered content height back for auto-sizing. These tests pin
 * that contract: both theme blocks present, the full token subset delivered,
 * the listener wired to the same key the parent posts, the auto-height
 * reporter present, and — load-bearing for the no-reload toggle — the two
 * per-theme headers differing by exactly the baked initial-class statement.
 */
import { describe, expect, test } from 'bun:test';
import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import {
  buildPreviewIframeHeader,
  buildPreviewThemeMessage,
  type PreviewTheme,
  parsePreviewHeightMessage,
} from './preview-iframe-header';

const THEMES: readonly PreviewTheme[] = ['light', 'dark'];
const INITIAL_CLASS_STATEMENT = "d.classList.add('dark');";

/** Count non-overlapping occurrences of `sub` in `s`. */
function count(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

describe('buildPreviewIframeHeader — theme token injection', () => {
  for (const theme of THEMES) {
    const header = buildPreviewIframeHeader(theme);

    test(`[${theme}] injects both :root and :root.dark token blocks`, () => {
      expect(header).toContain(':root{');
      expect(header).toContain(':root.dark{');
    });

    test(`[${theme}] delivers every token in both light and dark`, () => {
      for (const t of PREVIEW_THEME_TOKENS) {
        expect(header).toContain(`${t.name}:${t.light}`);
        expect(header).toContain(`${t.name}:${t.dark}`);
      }
    });

    test(`[${theme}] sets color-scheme so native controls theme`, () => {
      expect(header).toContain('color-scheme:light');
      expect(header).toContain('color-scheme:dark');
    });

    test(`[${theme}] injects themed body defaults`, () => {
      expect(header).toContain('background:var(--background)');
      expect(header).toContain('color:var(--foreground)');
    });

    test(`[${theme}] wires the postMessage theme listener`, () => {
      expect(header).toContain('<script>');
      expect(header).toContain("addEventListener('message'");
      // The listener must key off the exact payload key the parent posts.
      const messageKey = Object.keys(buildPreviewThemeMessage('light'))[0];
      expect(header).toContain(`e.data.${messageKey}`);
    });
  }

  test('dark bakes one extra initial-class statement vs light', () => {
    const light = buildPreviewIframeHeader('light');
    const dark = buildPreviewIframeHeader('dark');
    // Light still defines the add('dark') path inside the message listener
    // (1 occurrence); dark adds the bootstrap initial-class statement (2).
    expect(count(light, INITIAL_CLASS_STATEMENT)).toBe(1);
    expect(count(dark, INITIAL_CLASS_STATEMENT)).toBe(2);
  });

  test('light and dark headers differ ONLY by the baked class', () => {
    // Load-bearing: a theme toggle re-skins the live iframe via postMessage
    // with no srcDoc rebuild. That is only sound because the CSP, both <style>
    // blocks, and the scrollbar style are byte-identical across themes — so the
    // postMessage-flipped iframe renders exactly what a fresh dark-baked srcDoc
    // would. `.replace` drops the first (bootstrap) occurrence only; the
    // listener's copy is untouched.
    const light = buildPreviewIframeHeader('light');
    const dark = buildPreviewIframeHeader('dark');
    expect(dark.replace(INITIAL_CLASS_STATEMENT, '')).toBe(light);
  });
});

describe('buildPreviewThemeMessage', () => {
  test('payload carries the resolved theme under a stable key', () => {
    expect(buildPreviewThemeMessage('dark')).toEqual({ okPreviewTheme: 'dark' });
    expect(buildPreviewThemeMessage('light')).toEqual({ okPreviewTheme: 'light' });
  });
});

describe('buildPreviewIframeHeader — auto-height reporting', () => {
  for (const theme of THEMES) {
    const header = buildPreviewIframeHeader(theme);

    test(`[${theme}] the bootstrap script reports content height`, () => {
      // The iframe measures its body box and posts the height back so the
      // NodeView can fit the wrapper to the content (auto-height).
      expect(header).toContain('okPreviewHeight');
      expect(header).toContain('getBoundingClientRect');
      expect(header).toContain('ResizeObserver');
    });
  }

  test('the theme listener honors only the parent window', () => {
    // An embed's own script can postMessage to itself; the listener drops
    // anything whose source is not the parent so an embed cannot spoof a
    // theme flip.
    expect(buildPreviewIframeHeader('light')).toContain('e.source!==parent');
  });
});

describe('parsePreviewHeightMessage', () => {
  test('reads a positive height, rounding up', () => {
    expect(parsePreviewHeightMessage({ okPreviewHeight: 412 })).toBe(412);
    expect(parsePreviewHeightMessage({ okPreviewHeight: 412.4 })).toBe(413);
  });

  test('rejects non-height payloads', () => {
    expect(parsePreviewHeightMessage(null)).toBeNull();
    expect(parsePreviewHeightMessage('412')).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewTheme: 'dark' })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: 0 })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: -10 })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: 'tall' })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: Number.NaN })).toBeNull();
    // Infinity / -Infinity are distinct from NaN and exercise the
    // `Number.isFinite` guard's other branch — pin both.
    expect(parsePreviewHeightMessage({ okPreviewHeight: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: Number.NEGATIVE_INFINITY })).toBeNull();
  });
});
