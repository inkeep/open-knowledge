import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  CANVAS_BG_DARK,
  CHROME_BG_DARK,
  CHROME_BG_LIGHT,
  SIDEBAR_BG_LIGHT,
} from '../../../core/src/constants/chrome.ts';
import { chromeTokensVitePlugin } from './chrome-tokens-vite-plugin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../globals.css');

describe('chromeTokensVitePlugin', () => {
  const plugin = chromeTokensVitePlugin({ globalsCssPath: GLOBALS_CSS });

  test('plugin name is namespaced', () => {
    expect(plugin.name).toBe('ok:chrome-tokens');
  });

  test('plugin runs as a pre-transform so it beats Vite HTML rewriters', () => {
    expect(plugin.enforce).toBe('pre');
  });

  test('transformIndexHtml substitutes both placeholders with the resolved hex', () => {
    const html =
      '<style>html { background-color: __OK_SIDEBAR_BG_LIGHT__ } html.dark { background-color: __OK_CHROME_BG_DARK__ }</style>';
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    const out = transform.handler(html);
    expect(out).toContain(`background-color: ${SIDEBAR_BG_LIGHT}`);
    expect(out).toContain(`background-color: ${CHROME_BG_DARK}`);
    expect(out).not.toContain('__OK_SIDEBAR_BG_LIGHT__');
    expect(out).not.toContain('__OK_CHROME_BG_DARK__');
  });

  test('html without placeholders is returned unchanged', () => {
    const html = '<style>html { background-color: red }</style>';
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    expect(transform.handler(html)).toBe(html);
  });

  test('uninstall page pre-paints its dark canvas rather than the main window frame', () => {
    const html = readFileSync(resolve(HERE, '../../uninstall.html'), 'utf8');
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    const out = transform.handler(html);
    expect(out).toContain(`html.dark { background-color: ${CANVAS_BG_DARK} }`);
    expect(out).not.toContain('__OK_CANVAS_BG_DARK__');
    expect(CANVAS_BG_DARK).not.toBe(CHROME_BG_DARK);
  });

  test('the web pre-paint uses the light sidebar while the light frame uses the desk', () => {
    const html = readFileSync(resolve(HERE, '../../index.html'), 'utf8');
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    const out = transform.handler(html);
    expect(out).toContain(`html { background-color: ${SIDEBAR_BG_LIGHT} }`);
    expect(out).toContain(`html.dark { background-color: ${CHROME_BG_DARK} }`);
    expect(out).not.toMatch(/__OK_[A-Z_]+_BG_[A-Z]+__/);
    expect(SIDEBAR_BG_LIGHT).toBe('#fafafa');
    expect(CHROME_BG_LIGHT).toBe('#f5f5f5');
  });

  test('uninstall page pre-paints the light sidebar', () => {
    const html = readFileSync(resolve(HERE, '../../uninstall.html'), 'utf8');
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    expect(transform.handler(html)).toContain(`html { background-color: ${SIDEBAR_BG_LIGHT} }`);
  });

  test('multiple occurrences of the same placeholder are all replaced', () => {
    const html = '__OK_SIDEBAR_BG_LIGHT__/__OK_SIDEBAR_BG_LIGHT__/__OK_CHROME_BG_DARK__';
    const transform = plugin.transformIndexHtml as {
      handler: (html: string) => string;
    };
    expect(transform.handler(html)).toBe(
      `${SIDEBAR_BG_LIGHT}/${SIDEBAR_BG_LIGHT}/${CHROME_BG_DARK}`,
    );
  });
});

function sidebarCss(light: string, dark: string): string {
  return `:root {\n  --desk: oklch(from var(--sidebar) calc(l - 0.015) c h);\n  --sidebar: ${light};\n}\n.dark {\n  --sidebar: ${dark};\n  --background: ${dark};\n}\nhtml.dark:not([data-color-theme]) {\n  --desk: ${dark};\n}\n`;
}

test('a running dev server serves the --sidebar token the stylesheet holds now, not the one it held at start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-chrome-tokens-'));
  try {
    const cssPath = join(dir, 'globals.css');
    writeFileSync(cssPath, sidebarCss('oklch(0.985 0 0)', 'oklch(0.205 0 0)'));
    const plugin = chromeTokensVitePlugin({ globalsCssPath: cssPath });
    const buildStart = plugin.buildStart as () => void;
    const transform = plugin.transformIndexHtml as { handler: (html: string) => string };
    buildStart();
    expect(transform.handler('__OK_SIDEBAR_BG_LIGHT__ __OK_CHROME_BG_DARK__')).toBe(
      '#fafafa #171717',
    );

    writeFileSync(cssPath, sidebarCss('oklch(0.9 0 0)', 'oklch(0.205 0 0)'));

    expect(transform.handler('__OK_SIDEBAR_BG_LIGHT__ __OK_CHROME_BG_DARK__')).toBe(
      '#dedede #171717',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
