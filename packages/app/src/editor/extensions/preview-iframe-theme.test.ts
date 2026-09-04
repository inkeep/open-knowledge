import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  buildPreviewIframeHeader,
  buildPreviewThemeMessage,
  type PreviewTheme,
  parsePreviewHeightMessage,
} from './preview-iframe-header';

const THEMES: readonly PreviewTheme[] = ['light', 'dark'];
const INITIAL_CLASS_STATEMENT = "d.classList.add('dark');";

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
      const messageKey = Object.keys(buildPreviewThemeMessage('light'))[0];
      expect(header).toContain(`e.data.${messageKey}`);
    });
  }

  test('dark bakes one extra initial-class statement vs light', () => {
    const light = buildPreviewIframeHeader('light');
    const dark = buildPreviewIframeHeader('dark');
    expect(count(light, INITIAL_CLASS_STATEMENT)).toBe(1);
    expect(count(dark, INITIAL_CLASS_STATEMENT)).toBe(2);
  });

  test('light and dark headers differ ONLY by the baked class', () => {
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
      expect(header).toContain('okPreviewHeight');
      expect(header).toContain('getBoundingClientRect');
      expect(header).toContain('ResizeObserver');
    });
  }

  test('the theme listener honors only the parent window', () => {
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
    expect(parsePreviewHeightMessage({ okPreviewHeight: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsePreviewHeightMessage({ okPreviewHeight: Number.NEGATIVE_INFINITY })).toBeNull();
  });
});
