import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderChromeConstantsModule,
  resolveChromeTokensFromCss,
} from '../../scripts/chrome-resolver.ts';
import { CHROME_BG_DARK, CHROME_BG_LIGHT } from './chrome.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../../../app/src/globals.css');

describe('chrome.ts drift-check', () => {
  const tokens = resolveChromeTokensFromCss(GLOBALS_CSS);

  test('CHROME_BG_LIGHT matches resolved --sidebar from :root', () => {
    expect(CHROME_BG_LIGHT).toBe(tokens.light);
  });

  test('CHROME_BG_DARK matches resolved --sidebar from .dark', () => {
    expect(CHROME_BG_DARK).toBe(tokens.dark);
  });

  test('hex values are sRGB 6-digit lowercase format', () => {
    expect(CHROME_BG_LIGHT).toMatch(/^#[0-9a-f]{6}$/);
    expect(CHROME_BG_DARK).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('chrome constants are visually distinct (light != dark)', () => {
    expect(CHROME_BG_LIGHT).not.toBe(CHROME_BG_DARK);
  });

  test('renderChromeConstantsModule emits a body that exports both constants', () => {
    const body = renderChromeConstantsModule(tokens);
    expect(body).toContain(`CHROME_BG_LIGHT = '${tokens.light}'`);
    expect(body).toContain(`CHROME_BG_DARK = '${tokens.dark}'`);
  });
});

describe('chrome-resolver: selector matching is exact (not wildcard)', () => {
  // The selector argument feeds a `new RegExp(...)` — any unescaped regex
  // metacharacter (`.`, `*`, etc.) silently widens the match. Real CSS
  // can contain neighbouring blocks that match a wildcard interpretation
  // of `.dark` (e.g. `Xdark { ... }`), and selecting them would resolve
  // chrome to the wrong color. Exercise that exact shape — synthetic CSS
  // where a literal `.dark` and a same-position `Xdark` differ in their
  // `--sidebar` value, so the wrong selector match is observable.
  let tmpDir: string;

  test('matches `.dark` literally, not `<any-char>dark`', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chrome-resolver-test-'));
    const cssPath = join(tmpDir, 'globals.css');
    // `Xdark { --sidebar: oklch(0.5 0 0); }` must NOT match the `.dark`
    // selector — the resolver should pick the literal `.dark` block.
    const css = `
:root {
  --sidebar: oklch(0.985 0 0);
}

Xdark {
  --sidebar: oklch(0.5 0 0);
}

.dark {
  --sidebar: oklch(0.205 0 0);
}
`;
    writeFileSync(cssPath, css, 'utf8');
    try {
      const tokens = resolveChromeTokensFromCss(cssPath);
      // Light value is `:root` only (unaffected); pin it to confirm the
      // light branch still resolves correctly under the same harness.
      expect(tokens.light).toBe('#fafafa');
      // Dark value MUST come from `.dark`, not `Xdark`. With a broken
      // selector escape, the wildcard `.` would match `X` first and the
      // resolver would resolve to the wrong color.
      expect(tokens.dark).toBe('#171717');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
