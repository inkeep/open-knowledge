
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_GATED_WINDOW_WRITERS } from './dev-gate-allowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const E2E_DIRS = [
  join(__dirname, '..', 'stress'),
  join(__dirname, '..', 'visual'),
  join(__dirname, '..', 'a11y'),
];
const APP_SRC_DIR = join(__dirname, '..', '..', 'src');

interface FileLines {
  path: string;
  absPath: string;
  lines: string[];
}

function listE2eFiles(): FileLines[] {
  const all: FileLines[] = [];
  for (const dir of E2E_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.e2e.ts')) continue;
      const absPath = join(dir, name);
      const source = readFileSync(absPath, 'utf-8');
      all.push({
        path: relative(REPO_ROOT, absPath),
        absPath,
        lines: source.split('\n'),
      });
    }
  }
  return all;
}

function listAppSrcTsFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      if (name.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.isFile()) continue;
      if (!name.name.endsWith('.ts') && !name.name.endsWith('.tsx')) continue;
      if (name.name.endsWith('.test.ts') || name.name.endsWith('.test.tsx')) continue;
      if (name.name.endsWith('.spec.ts') || name.name.endsWith('.spec.tsx')) continue;
      const source = readFileSync(abs, 'utf-8');
      out.push({ path: relative(REPO_ROOT, abs), absPath: abs, lines: source.split('\n') });
    }
  }
  walk(APP_SRC_DIR);
  return out;
}

const SPAWN_BUN_PATTERN = /spawn\(\s*['"]bun['"]/;
const SPAWN_REQUIRED_ENV_KEYS = ['OK_TEST_VITE_CACHE_DIR', 'OK_TEST_SKIP_I18N_COMPILE'] as const;

function findSpawnIsolationViolations(
  lines: string[],
): Array<{ line: number; missingKey: string }> {
  const spawnLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SPAWN_BUN_PATTERN.test(lines[i] ?? '')) spawnLines.push(i + 1);
  }
  if (spawnLines.length === 0) return [];
  const source = lines.join('\n');
  const violations: Array<{ line: number; missingKey: string }> = [];
  for (const key of SPAWN_REQUIRED_ENV_KEYS) {
    if (!source.includes(key)) {
      violations.push({ line: spawnLines[0] ?? 1, missingKey: key });
    }
  }
  return violations;
}

function collectMatches(
  files: FileLines[],
  predicate: (line: string, lineIdx: number, file: FileLines) => boolean,
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      if (predicate(file.lines[i] ?? '', i, file)) {
        violations.push(`  ${file.path}:${i + 1}    ${(file.lines[i] ?? '').trim()}`);
      }
    }
  }
  return violations;
}

describe('E2E STOP rule — zero allowlist', () => {
  const e2eFiles = listE2eFiles();

  test('there are E2E files to check (sanity)', () => {
    expect(e2eFiles.length).toBeGreaterThan(0);
  });

  test('no page.waitForTimeout( in tests/{stress,visual,a11y}/*.e2e.ts (AC-3)', () => {
    const violations = collectMatches(e2eFiles, (line) => line.includes('page.waitForTimeout('));
    if (violations.length > 0) {
      throw new Error(
        `page.waitForTimeout( pattern found — replace with condition-based wait per D-Q1:\n${violations.join('\n')}`,
      );
    }
  });

  test("no waitUntil: 'networkidle' in tests/{stress,visual,a11y}/*.e2e.ts (AC-4)", () => {
    const violations = collectMatches(e2eFiles, (line) =>
      /waitUntil:\s*['"]networkidle['"]/.test(line),
    );
    if (violations.length > 0) {
      throw new Error(
        `waitUntil: 'networkidle' pattern found — use 'domcontentloaded' + waitForActiveProviderSynced instead:\n${violations.join('\n')}`,
      );
    }
  });

  test('no new Promise + setTimeout busy-wait in tests/{stress,visual,a11y}/*.e2e.ts (D-Q14)', () => {
    const pattern = /new Promise\(\s*(\w+)\s*=>\s*setTimeout\(\s*\1\s*,/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `\`new Promise(r => setTimeout(r, N))\` busy-wait found — use a condition-based wait:\n${violations.join('\n')}`,
      );
    }
  });

  test('no page.pause( in tests/{stress,visual,a11y}/*.e2e.ts (D-Q14)', () => {
    const violations = collectMatches(e2eFiles, (line) => line.includes('page.pause('));
    if (violations.length > 0) {
      throw new Error(
        `page.pause( found — debugger pauses must not land in committed E2E tests:\n${violations.join('\n')}`,
      );
    }
  });

  test("no test.skip(browserName === 'webkit') in tests/{stress,visual,a11y}/*.e2e.ts (AC-5 ratchet)", () => {
    const pattern = /test\.skip\(\s*browserName\s*===\s*['"]webkit['"]/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `webkit-skip pattern reintroduced — chromium-only CI ratchet (D-Q10):\n${violations.join('\n')}`,
      );
    }
  });

  test("no keyboard.press('Meta+X') — use ControlOrMeta+X for cross-platform CI (D-Q10)", () => {
    const pattern = /keyboard\.press\(\s*['"`]Meta\+[A-Za-z][A-Za-z]*['"`]/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `keyboard.press('Meta+X') — replace with 'ControlOrMeta+X' so CI (Linux chromium) maps to Ctrl+X:\n${violations.join('\n')}`,
      );
    }
  });

  test('no inner-file helper imports — must use barrel ./_helpers (D-Q11)', () => {
    const innerImport = /from\s+['"]\.\.?(?:\/[^'"]*)?\/_helpers\/[a-zA-Z][\w-]*['"]/;
    const violations = collectMatches(e2eFiles, (line) => innerImport.test(line));
    if (violations.length > 0) {
      throw new Error(
        `Inner-file helper import found — import from the barrel ('./_helpers') only:\n${violations.join('\n')}`,
      );
    }
  });

  test('no ungated window.__ writes outside dev-gate allowlist (US-006/US-026)', () => {
    const srcFiles = listAppSrcTsFiles();
    const writePattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*=/;
    const equalityPattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*===?/;
    const definePropertyPattern =
      /Object\.defineProperty\s*\(\s*window\s*,\s*['"]__[A-Za-z_][A-Za-z0-9_]*['"]/;

    const violations: string[] = [];
    for (const file of srcFiles) {
      if (DEV_GATED_WINDOW_WRITERS.includes(file.path)) continue;
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        const isAssignWrite = writePattern.test(line) && !equalityPattern.test(line);
        const isDefinePropertyWrite = definePropertyPattern.test(line);
        if (!isAssignWrite && !isDefinePropertyWrite) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Ungated window.__ write outside the dev-gate allowlist — wrap in if (import.meta.env.DEV) and add to dev-gate-allowlist.ts:\n${violations.join('\n')}`,
      );
    }
  });

  test('no editor.mount( / editor.unmount( in V2 cache surfaces (precedent §25(a), SPEC US-001 Phase 1.0)', () => {
    const V2_CACHE_SURFACES = [
      join(APP_SRC_DIR, 'editor', 'editor-cache.ts'),
      join(APP_SRC_DIR, 'editor', 'TiptapEditor.tsx'),
    ];
    const pattern = /\beditor\.(mount|unmount)\s*\(/;
    const violations: string[] = [];
    for (const abs of V2_CACHE_SURFACES) {
      let source: string;
      try {
        source = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!pattern.test(line)) continue;
        const trimmed = line.trim();
        if (
          trimmed.startsWith('*') ||
          trimmed.startsWith('//') ||
          trimmed.includes('`editor.mount(') ||
          trimmed.includes('`editor.unmount(')
        )
          continue;
        violations.push(`  ${relative(REPO_ROOT, abs)}:${i + 1}    ${trimmed}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `editor.mount()/unmount() call found in a V2-cache surface — use raw editor.editorView.dom reparent instead per precedent §25(a):\n${violations.join('\n')}`,
      );
    }
  });

  test('no waitForFunction(fn, { timeout/polling }) — options must be 3rd arg (precedent §20(j))', () => {
    const singleLinePattern = /waitForFunction\s*\([^)]*?=>\s*[^,]*,\s*\{\s*(timeout|polling)\s*:/;
    const multiLineKeyword = /^\s*\{\s*(timeout|polling)\s*:/;
    const fnBodyCloseTerminator = /\)\s*,\s*$/;

    const violations: string[] = [];
    for (const file of e2eFiles) {
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        if (singleLinePattern.test(line)) {
          violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
          continue;
        }
        if (!multiLineKeyword.test(line)) continue;
        let p = i - 1;
        while (p >= 0) {
          const prev = (file.lines[p] ?? '').trim();
          if (prev === '' || prev.startsWith('//') || prev.startsWith('*')) {
            p--;
            continue;
          }
          break;
        }
        if (p < 0) continue;
        const prev = file.lines[p] ?? '';
        if (!fnBodyCloseTerminator.test(prev)) continue;
        let scanUp = p;
        let foundCall = false;
        for (let k = 0; k < 10 && scanUp >= 0; k++, scanUp--) {
          if ((file.lines[scanUp] ?? '').includes('waitForFunction(')) {
            foundCall = true;
            break;
          }
        }
        if (!foundCall) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `waitForFunction(fn, { timeout/polling }) pattern — options as 2nd arg is bound to \`arg\` and silently ignored. Pass \`null\` as 2nd arg: \`waitForFunction(fn, null, { timeout: N })\`. See AGENTS.md §20(j):\n${violations.join('\n')}`,
      );
    }
  });

  test('e2e files that spawn a dev server must isolate shared mutable state (vite cache + i18n compile)', () => {
    const violations: string[] = [];
    for (const file of e2eFiles) {
      for (const v of findSpawnIsolationViolations(file.lines)) {
        violations.push(
          `  ${file.path}:${v.line}    spawn('bun', …) without ${v.missingKey} anywhere in the file`,
        );
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `dev-server spawn without shared-state isolation — pass OK_TEST_VITE_CACHE_DIR (via prepareViteCacheDir from ./_helpers, rmSync in teardown) and OK_TEST_SKIP_I18N_COMPILE: '1' in the spawn env:\n${violations.join('\n')}`,
      );
    }
  });

  test('spawn-isolation rule fires on a planted violation and not on adjacent negatives', () => {
    const planted = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      '  env: { ...process.env, VITE_PORT: String(port) },',
      '});',
    ];
    const fired = findSpawnIsolationViolations(planted);
    expect(fired.length).toBe(2);
    expect(fired[0]?.line).toBe(1);

    const compliant = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      "  env: { OK_TEST_VITE_CACHE_DIR: dir, OK_TEST_SKIP_I18N_COMPILE: '1' },",
      '});',
    ];
    expect(findSpawnIsolationViolations(compliant).length).toBe(0);

    const otherSpawn = ["const proc = spawn('node', ['script.js'], { env: {} });"];
    expect(findSpawnIsolationViolations(otherSpawn).length).toBe(0);

    const halfCompliant = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      '  env: { OK_TEST_VITE_CACHE_DIR: dir },',
      '});',
    ];
    const halfFired = findSpawnIsolationViolations(halfCompliant);
    expect(halfFired.length).toBe(1);
    expect(halfFired[0]?.missingKey).toBe('OK_TEST_SKIP_I18N_COMPILE');

    const multiSpawn = [
      "const p1 = spawn('bun', ['run', '--silent', 'dev'], {",
      "  env: { OK_TEST_VITE_CACHE_DIR: d, OK_TEST_SKIP_I18N_COMPILE: '1' },",
      '});',
      "const p2 = spawn('bun', ['run', '--silent', 'dev'], {",
      '  env: { VITE_PORT: String(port) },',
      '});',
    ];
    expect(findSpawnIsolationViolations(multiSpawn).length).toBe(0);
  });

  test('window.__activeEditor is published only by DocumentContext.tsx (regression — PR #168 merge collision)', () => {
    const srcFiles = listAppSrcTsFiles();
    const directAssignPattern = /window\.__activeEditor\s*=/;
    const equalityPattern = /window\.__activeEditor\s*===?/;
    const definePropertyPattern =
      /Object\.defineProperty\s*\(\s*window\s*,\s*['"]__activeEditor['"]/;
    const ownerFile = 'packages/app/src/editor/DocumentContext.tsx';

    const violations: string[] = [];
    for (const file of srcFiles) {
      if (file.path === ownerFile) continue;
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        const isAssign = directAssignPattern.test(line) && !equalityPattern.test(line);
        const isDefine = definePropertyPattern.test(line);
        if (!isAssign && !isDefine) continue;
        violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `window.__activeEditor must be published only by DocumentContext.tsx — additional writers collide with the getter-only accessor and throw TypeError on doc open in DEV. Delete the direct write and read through window.__activeEditor (the getter already resolves via the active-editor.ts registry, which TiptapEditor already populates via registerEditor/unregisterEditor):\n${violations.join('\n')}`,
      );
    }
  });

  test('selection-halo CSS rules use plugin-state propagation, not `:has()` (Precedent #34)', () => {
    const cssPath = join(APP_SRC_DIR, 'globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    const lines = css.split('\n');

    const hasPattern = /:has\(/;
    const selectionMarker =
      /data-selected|data-has-child-selected|--selection-halo|selection-halo-opacity/;
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!hasPattern.test(line)) continue;

      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length, i + 4);
      const selectorContext = lines.slice(windowStart, windowEnd).join('\n');

      if (selectionMarker.test(selectorContext)) {
        violations.push(`  packages/app/src/globals.css:${i + 1}    ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Selection-halo CSS rules must not use \`:has()\` — precedent #34 requires innermost-wins via plugin-state propagation (\`data-has-child-selected\`). Move the cascade logic into SelectionStatePlugin's apply function and let JsxComponentView emit the attribute:\n${violations.join('\n')}`,
      );
    }
  });

  test('selection-halo transition uses `var(--ease-out-strong)`, not bare `ease-out` (round-2 review fix)', () => {
    const cssPath = join(APP_SRC_DIR, 'globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    const lines = css.split('\n');

    const haloStart = lines.findIndex((l) => /\/\*\s*7a\..*selection/i.test(l));
    if (haloStart === -1) {
      throw new Error(
        `globals.css: expected "7a. Selection halo" section anchor not found — same rename/removal case as the :has() rule above.`,
      );
    }
    const sectionHeaderPattern = /\/\*\s*(?:7b|8|9)\./i;
    let haloEnd = lines.length;
    for (let i = haloStart + 1; i < lines.length; i++) {
      if (sectionHeaderPattern.test(lines[i] ?? '')) {
        haloEnd = i;
        break;
      }
    }

    const violations: string[] = [];
    for (let i = haloStart; i < haloEnd; i++) {
      const line = lines[i] ?? '';
      if (!line.includes('transition')) continue;
      const stripped = line.replace(/var\([^)]*\)/g, '');
      if (/\bease-out\b/.test(stripped)) {
        violations.push(`  packages/app/src/globals.css:${i + 1}    ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Selection-halo transition uses bare \`ease-out\` — use \`var(--ease-out-strong)\` for consistency with the repo's 7 other transitions (round-2 review fix, commit 4e9d96a5):\n${violations.join('\n')}`,
      );
    }
  });

  test('predev routes i18n compile through the OK_TEST_SKIP_I18N_COMPILE guard (not a direct compile)', () => {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const predev = pkg.scripts?.predev ?? '';
    const errors: string[] = [];
    if (!predev.includes('i18n-compile-unless-skipped.sh')) {
      errors.push(
        'packages/app/package.json "predev" must route the i18n compile through ' +
          'scripts/i18n-compile-unless-skipped.sh (the OK_TEST_SKIP_I18N_COMPILE guard).',
      );
    }
    if (/\b(?:bun run i18n:compile|lingui compile)\b/.test(predev)) {
      errors.push(
        'packages/app/package.json "predev" invokes the i18n compile directly, bypassing the ' +
          'OK_TEST_SKIP_I18N_COMPILE guard — every concurrent e2e dev-server boot then rewrites ' +
          'src/locales/<locale>/messages.json and Vite full-page-reloads running tests mid-evaluate.',
      );
    }
    if (errors.length > 0) {
      throw new Error(`${errors.join('\n')}\nFound predev:\n  ${predev}`);
    }
  });
});
