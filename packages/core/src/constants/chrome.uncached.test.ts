import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  renderChromeConstantsModule,
  resolveChromeTokensFromCss,
} from '../../scripts/chrome-resolver.ts';
import {
  CANVAS_BG_DARK,
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  SIDEBAR_BG_DARK,
  SIDEBAR_BG_LIGHT,
} from './chrome.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../../../app/src/globals.css');

describe('chrome.ts drift-check', () => {
  const tokens = resolveChromeTokensFromCss(GLOBALS_CSS);

  test('CHROME_BG_LIGHT matches the light --desk derived from :root --sidebar', () => {
    expect(CHROME_BG_LIGHT).toBe(tokens.light);
    expect(tokens.light).toBe('#f5f5f5');
  });

  test('SIDEBAR_BG_LIGHT matches resolved --sidebar from :root', () => {
    expect(SIDEBAR_BG_LIGHT).toBe(tokens.lightSidebar);
    expect(tokens.lightSidebar).toBe('#fafafa');
  });

  test('CHROME_BG_DARK matches the default dark --desk', () => {
    expect(CHROME_BG_DARK).toBe(tokens.dark);
  });

  test('SIDEBAR_BG_DARK matches resolved --sidebar from .dark', () => {
    expect(SIDEBAR_BG_DARK).toBe(tokens.darkSidebar);
  });

  test('CANVAS_BG_DARK matches resolved --background from .dark', () => {
    expect(CANVAS_BG_DARK).toBe(tokens.darkCanvas);
  });

  test('hex values are sRGB 6-digit lowercase format', () => {
    expect(CHROME_BG_LIGHT).toMatch(/^#[0-9a-f]{6}$/);
    expect(SIDEBAR_BG_LIGHT).toMatch(/^#[0-9a-f]{6}$/);
    expect(CHROME_BG_DARK).toMatch(/^#[0-9a-f]{6}$/);
    expect(SIDEBAR_BG_DARK).toMatch(/^#[0-9a-f]{6}$/);
    expect(CANVAS_BG_DARK).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('chrome constants are visually distinct (light != dark)', () => {
    expect(CHROME_BG_LIGHT).not.toBe(CHROME_BG_DARK);
  });

  test('renderChromeConstantsModule emits a body that exports both constants', () => {
    const body = renderChromeConstantsModule(tokens);
    expect(body).toContain(`CHROME_BG_LIGHT = '${tokens.light}'`);
    expect(body).toContain(`CHROME_BG_DARK = '${tokens.dark}'`);
    expect(body).toContain(`SIDEBAR_BG_LIGHT = '${tokens.lightSidebar}'`);
    expect(body).toContain(`SIDEBAR_BG_DARK = '${tokens.darkSidebar}'`);
    expect(body).toContain(`CANVAS_BG_DARK = '${tokens.darkCanvas}'`);
    expect(body).toContain('export const APP_HEADER_HEIGHT_PX = 44;');
    expect(body).toContain('export const REDUCED_CHROME_HEADER_HEIGHT_PX = 48;');
  });

  test('the checked-in chrome.ts is exactly what the generator renders', () => {
    expect(readFileSync(resolve(HERE, 'chrome.ts'), 'utf8')).toBe(
      renderChromeConstantsModule(tokens),
    );
  });
});

describe('chrome-resolver: selector matching is exact (not wildcard)', () => {
  let tmpDir: string;

  test('matches `.dark` literally, not `<any-char>dark`', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chrome-resolver-test-'));
    const cssPath = join(tmpDir, 'globals.css');
    const css = `
:root {
  --desk: oklch(from var(--sidebar) calc(l - 0.015) c h);
  --sidebar: oklch(0.985 0 0);
}

Xdark {
  --sidebar: oklch(0.5 0 0);
}

htmlXdark:not([data-color-theme]) {
  --desk: oklch(0.5 0 0);
}

.dark {
  --background: oklch(0.195 0 0);
  --sidebar: oklch(0.205 0 0);
}

html.dark:not([data-color-theme]) {
  --desk: oklch(0.28 0 0);
}
`;
    writeFileSync(cssPath, css, 'utf8');
    try {
      const tokens = resolveChromeTokensFromCss(cssPath);
      expect(tokens.light).toBe('#f5f5f5');
      expect(tokens.lightSidebar).toBe('#fafafa');
      expect(tokens.dark).toBe('#292929');
      expect(tokens.darkSidebar).toBe('#171717');
      expect(tokens.darkCanvas).toBe('#151515');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('chrome-resolver: light --desk shape', () => {
  test('a :root --desk that is not a lightness offset from --sidebar is rejected', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'chrome-resolver-test-'));
    const cssPath = join(tmpDir, 'globals.css');
    writeFileSync(
      cssPath,
      `:root {
  --desk: oklch(from var(--sidebar) l c h / 0.5);
  --sidebar: oklch(0.985 0 0);
}

.dark {
  --background: oklch(0.195 0 0);
  --sidebar: oklch(0.205 0 0);
}

html.dark:not([data-color-theme]) {
  --desk: oklch(0.28 0 0);
}
`,
      'utf8',
    );
    try {
      expect(() => resolveChromeTokensFromCss(cssPath)).toThrow(/--desk/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
