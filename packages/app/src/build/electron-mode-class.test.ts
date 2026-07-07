/**
 * Source-level guards for the FOUC-time `html.electron-mode` class addition.
 *
 * Repo convention: no @testing-library / happy-dom. The class addition runs
 * in the inline `<script>` block of `packages/app/index.html` — DOM-bound
 * runtime behavior is exercised end-to-end via Playwright in the Electron
 * host context. These guards lock the structural choices a future refactor
 * would silently break:
 *
 *   - The class name is exactly `electron-mode` (CSS rules in globals.css
 *     scope to `html.electron-mode`; renaming here without renaming there
 *     is silent regression).
 *   - The detection condition is `window.okDesktop` truthy (the canonical
 *     idiom — matches `OpenInAgentMenu`, `FileTree`, `EditorHeader`,
 *     `EditorTabs`, `FileSidebar`).
 *   - The class is added on `document.documentElement` (the `<html>` element
 *     — globals.css selector is `html.electron-mode`, NOT `body.electron-mode`).
 *   - The addition runs INSIDE the existing FOUC inline `<script>`, NOT in a
 *     React effect or main.tsx. Per FOUC discipline, the class must be on
 *     `<html>` BEFORE first paint so the alpha-aware CSS rules engage from
 *     byte 1.
 *   - The script body remains single-line (biome's HTML formatter reindents
 *     inline-script content; multi-line bodies create an infinite reformat
 *     loop at pre-commit).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTML = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');

describe('index.html FOUC inline script — electron-mode class', () => {
  test('inline FOUC script adds the electron-mode class to documentElement when window.okDesktop is present', () => {
    expect(HTML).toMatch(
      /if\s*\(\s*window\.okDesktop\s*\)\s*document\.documentElement\.classList\.add\(\s*['"]electron-mode['"]\s*\)/,
    );
  });

  test('class addition lives in the same <script> block as the existing dark-mode FOUC', () => {
    const themeFoucScript = HTML.match(
      /<script>\(\(\) => \{[^<]*classList\.add\(['"]dark['"]\)[^<]*\}\)\(\);<\/script>/,
    );
    expect(themeFoucScript).not.toBeNull();
    expect(themeFoucScript?.[0]).toContain('electron-mode');
  });

  test('class is added on documentElement (html), not body — matches globals.css scope', () => {
    expect(HTML).toMatch(/document\.documentElement\.classList\.add\(['"]electron-mode['"]\)/);
    expect(HTML).not.toMatch(/document\.body\.classList\.add\(['"]electron-mode['"]\)/);
  });

  test('FOUC inline script body remains single-line (no inner newlines — biome HTML formatter constraint)', () => {
    const inlineScripts = HTML.match(/<script>[^<]+<\/script>/g) ?? [];
    for (const tag of inlineScripts) {
      const body = tag.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(body).not.toMatch(/\n/);
    }
  });

  test('class name matches the CSS selector exactly (electron-mode, not electron / desktop / okDesktop)', () => {
    expect(HTML).toContain("'electron-mode'");
    expect(HTML).not.toMatch(/classList\.add\(\s*['"]electron['"]\s*\)/);
    expect(HTML).not.toMatch(/classList\.add\(\s*['"]okDesktop['"]\s*\)/);
  });
});
