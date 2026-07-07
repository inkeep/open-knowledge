/**
 * Mechanical guard for the E2E suite's zero-allowlist anti-pattern bans.
 *
 * Each banned pattern is enforced by a per-pattern test. Failure messages
 * list `<file>:<line>` for every violation so the developer can fix without
 * having to re-grep.
 *
 * Template: `packages/app/src/editor/clipboard/wysiwyg-stop-rule.test.ts` —
 * same per-pattern shape, same string-grep enforcement (cheapest mechanical
 * check that catches both spellings of each banned construct).
 *
 * Patterns enforced:
 *   1. `page.waitForTimeout(`
 *   2. `waitUntil: 'networkidle'`
 *   3. `new Promise(r => setTimeout(r,`
 *   4. `page.pause(`
 *   5. `test.skip(browserName === 'webkit'` — ratchet
 *   6. Inner-file helper imports     — barrel contract
 *   7. Ungated `window.__` writes outside the allowlist
 *   8. `window.__activeEditor` writes outside DocumentContext.tsx
 *      (regression — merge collision: TiptapEditor direct
 *      assignment clashed with main's getter-only defineProperty
 *      and threw TypeError on any doc open in DEV)
 *   9. `:has()` in selection-halo CSS rules (precedent #34 — innermost-wins
 *      via plugin state, not `:has()` cascade; Firefox compat + large-doc
 *      perf + SSR parity)
 *  10. Selection halo transition uses bare `ease-out` instead of
 *      `var(--ease-out-strong)` — consistency with the repo's custom
 *      easing token
 */

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
  /** Repo-relative path for failure messages. */
  path: string;
  /** Absolute path for reading. */
  absPath: string;
  /** Lines split on '\n', 0-indexed. */
  lines: string[];
}

/**
 * Enumerate every `*.e2e.ts` file across the three E2E directories
 * (`tests/stress`, `tests/visual`, `tests/a11y`). Each STOP rule applies
 * uniformly — a waitForTimeout in a visual/a11y test is as flaky as one in
 * stress. Previously scoped to stress/ only; broadened per a
 * review finding that every new visual/a11y test was shipping ~13 banned
 * `waitForTimeout` calls with no gate.
 */
function listE2eFiles(): FileLines[] {
  const all: FileLines[] = [];
  for (const dir of E2E_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Directory may not exist yet (future test suites add one).
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

/**
 * Core predicate of the spawn-isolation STOP rule, extracted so the rule's
 * planted-positive self-test can exercise it against inline fixtures (an
 * absence-checker without a planted positive is a vacuous no-op waiting to
 * happen). Returns one violation per missing key, anchored to the first
 * spawn line.
 *
 * Known limitation: the key check is FILE-scoped (`source.includes`), not
 * per-spawn-block — a file with one compliant and one non-compliant spawn
 * produces zero violations. No e2e file has two spawn blocks today; a
 * per-block check would need env-block span tracking this line scanner
 * doesn't do. The self-test pins this behavior explicitly.
 */
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
    // Chromium on Linux CI treats `Meta` as the Super / Windows key. PM's
    // `Mod-a` keymap resolves to `Ctrl+a` on Linux, so `keyboard.press('Meta+a')`
    // on CI does not trigger PM's selectAll command — `simulateCopyAndRead`
    // then returns an empty MIME map. `ControlOrMeta+X` (Playwright v1.37+)
    // maps to `Meta+X` on macOS and `Control+X` elsewhere, matching
    // `prosemirror-keymap`'s `Mod-` resolution.
    //
    // Scope: only keyboard shortcuts where the chord is meant to match a
    // platform-aware key binding (select-all, copy, cut, paste, end-of-doc,
    // start-of-doc, select-all-up, select-word-left/right). Plain `Meta`
    // key references in prose / identifiers are not banned.
    const pattern = /keyboard\.press\(\s*['"`]Meta\+[A-Za-z][A-Za-z]*['"`]/;
    const violations = collectMatches(e2eFiles, (line) => pattern.test(line));
    if (violations.length > 0) {
      throw new Error(
        `keyboard.press('Meta+X') — replace with 'ControlOrMeta+X' so CI (Linux chromium) maps to Ctrl+X:\n${violations.join('\n')}`,
      );
    }
  });

  test('no inner-file helper imports — must use barrel ./_helpers (D-Q11)', () => {
    // Banned: `from './_helpers/sidebar'`, `from './_helpers/provider'`, etc.
    // Allowed: `from './_helpers'` (resolves to ./_helpers/index.ts).
    // Also banned: deeper paths like `from '../_helpers/sidebar'`.
    // `[a-zA-Z]` (not `[a-z]`) so future PascalCase-named helper files
    // (e.g., `Clipboard.ts`) can't bypass the STOP rule via direct import.
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
    // Match `window.__name = ` (assignment) and `window.__name = (...)` shapes.
    const writePattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*=/;
    // Exclude pure equality / comparison usages by requiring no `==` or `===` immediately after.
    const equalityPattern = /window\.__[A-Za-z_][A-Za-z0-9_]*\s*===?/;
    // Match the `Object.defineProperty(window, '__name', …)` publication
    // shape used by `DocumentContext.tsx` for `window.__activeProvider`.
    // Without this, a new contributor adding a second
    // `Object.defineProperty(window, '__x', …)` writer outside the
    // allowlist would slip past the assignment-only regex above.
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
    // TipTap's `Editor.mount(container)` / `Editor.unmount()` API is BLOCKED
    // by `@tiptap/extension-drag-handle@4.x` (probe — closure-captured
    // editor ref hits TipTap's throwing proxy during re-create). V2 ships the
    // raw `editor.editorView.dom` reparent fallback instead. This STOP rule
    // is mechanical defense against a future contributor "simplifying" the
    // reparent back to the named API — which would silently regress the
    // cache on any doc that has a drag-handle NodeView.
    //
    // Scope: the V2-cache surface files — not ALL of packages/app/src/ — so
    // we don't forbid Editor.mount/unmount in unrelated test fixtures or
    // future features that don't go through the cache. The surface list is
    // small and explicit; add a new file here if a new cached surface lands.
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
        // File may be moved in a future refactor; don't crash the test.
        continue;
      }
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!pattern.test(line)) continue;
        // Allow references inside docstring/comment blocks — they're
        // forbidding the API, not calling it. Heuristic: if the trimmed
        // line starts with `*`, `//`, or contains the STOP marker, skip.
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
    // Playwright's `page.waitForFunction(pageFunction, arg?, options?)` is
    // strictly positional. When a test writes
    //   `waitForFunction(fn, { timeout: 10_000 })`
    // the `{ timeout: 10_000 }` is bound to `arg`, not `options` — the
    // intended timeout is silently ignored and the action falls back to
    // the test-level timeout (typically 120s). Empirical probe:
    // `waitForFunction(fn, { timeout: 200 })` takes 56_736ms vs 202ms for
    // `waitForFunction(fn, null, { timeout: 200 })` — same fn, only the
    // signature differs.
    //
    // Required shape: `waitForFunction(fn, null, { timeout: N })` — pass
    // `null` (or `undefined`, or a real arg value) as the 2nd positional,
    // options as the 3rd. See precedent #20(j).
    //
    // Detection:
    //   - Single-line:  `waitForFunction(...=>..., { timeout|polling: ...`
    //   - Multi-line:   a line whose trim is `{ timeout: ...` or
    //     `{ polling: ...` whose nearest previous non-blank, non-comment
    //     line ends with `),` (function-body close directly followed by
    //     options — no middle arg).
    const singleLinePattern = /waitForFunction\s*\([^)]*?=>\s*[^,]*,\s*\{\s*(timeout|polling)\s*:/;
    // Multi-line: accept both `{ timeout: ...` and `{ timeout: ..., ...`
    // trimmed-first-char shapes. No-intermediate-arg detected by the
    // preceding line ending in `),` (the function body's close).
    const multiLineKeyword = /^\s*\{\s*(timeout|polling)\s*:/;
    const fnBodyCloseTerminator = /\)\s*,\s*$/;

    const violations: string[] = [];
    for (const file of e2eFiles) {
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        if (singleLinePattern.test(line)) {
          // Exclude the CORRECT multi-arg form where the arg is itself an
          // object literal that happens to have a `timeout` field (rare
          // but possible). Require: BEFORE the `{ timeout`/`{ polling`
          // match, there is no bare `),` or `null,` / `undefined,` /
          // `identifier,` argument sequence. Conservative approach: the
          // single-line regex above already requires `=>` directly before
          // the comma-options, which means the arrow function is the
          // FIRST arg and the object is the SECOND — always buggy.
          violations.push(`  ${file.path}:${i + 1}    ${line.trim()}`);
          continue;
        }
        if (!multiLineKeyword.test(line)) continue;
        // Find previous non-blank, non-comment-only line.
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
        // Guard: preceding line ends with `),` AND that `)` was a
        // FUNCTION-BODY close (the arrow function's closing paren), not
        // an argument value's closing. Approximate by: scan up to 8
        // earlier lines; if a `waitForFunction(` occurs within the
        // block, this is the buggy shape. Otherwise not a match.
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
    // A per-test `bun run … dev` spawn shares two single-writer resources
    // with every concurrently booting peer server unless isolated:
    //   1. Vite's default `<root>/node_modules/.vite` — the dependency
    //      optimizer corrupts peers' chunk files mid-run, and each spawn
    //      pays a cold scan+optimize under full 4-worker contention (the
    //      init-load-byte-stable 12-run flake class).
    //      Mint via `prepareViteCacheDir(...)` from `./_helpers` (also
    //      copies the per-run warm seed) and pass OK_TEST_VITE_CACHE_DIR.
    //   2. predev's `lingui compile` + `biome format --write` against the
    //      shared src/locales catalogs — racing writers tear the JSON for
    //      any concurrent reader (the corrupted-catalog playwright failure).
    //      Pass OK_TEST_SKIP_I18N_COMPILE: '1';
    //      the warm-cache globalSetup boot compiles once per run.
    // Scope: `*.e2e.ts` only (listE2eFiles) — `_helpers/*.ts` is intentionally
    // exempt. The warm-cache globalSetup spawn omits OK_TEST_SKIP_I18N_COMPILE
    // on purpose: its uncontended boot is the one place the i18n catalogs
    // compile each run. A new spawn helper under _helpers/ needs manual review
    // against the two keys above; this rule will not catch it.
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

  /**
   * Planted-positive + adjacent-negative self-test for the spawn-isolation
   * rule above. The rule is an ABSENCE-checker (it passes by finding
   * nothing), so without this fixture a rotted `spawn('bun'…)` regex would
   * read as a perpetual green. The negative fixtures sit at the precision
   * boundary: same shape with the keys present, and a non-bun spawn.
   *
   */
  test('spawn-isolation rule fires on a planted violation and not on adjacent negatives', () => {
    const planted = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      '  env: { ...process.env, VITE_PORT: String(port) },',
      '});',
    ];
    // Missing BOTH keys → exactly 2 violations, anchored to the spawn line.
    const fired = findSpawnIsolationViolations(planted);
    expect(fired.length).toBe(2);
    expect(fired[0]?.line).toBe(1);

    // Adjacent negative 1: same spawn shape with both keys present → 0.
    const compliant = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      "  env: { OK_TEST_VITE_CACHE_DIR: dir, OK_TEST_SKIP_I18N_COMPILE: '1' },",
      '});',
    ];
    expect(findSpawnIsolationViolations(compliant).length).toBe(0);

    // Adjacent negative 2: a non-bun spawn without the keys → 0 (the rule
    // scopes to dev-server boots, not arbitrary subprocesses).
    const otherSpawn = ["const proc = spawn('node', ['script.js'], { env: {} });"];
    expect(findSpawnIsolationViolations(otherSpawn).length).toBe(0);

    // Half-compliant spawn (one key present, one absent) → exactly 1
    // violation naming the missing key. Guards the per-key loop: a
    // regression collapsing both checks into a single combined predicate
    // would still produce 2 violations for the both-missing fixture above
    // while silently passing single-key violations.
    const halfCompliant = [
      "const proc = spawn('bun', ['run', '--silent', 'dev'], {",
      '  env: { OK_TEST_VITE_CACHE_DIR: dir },',
      '});',
    ];
    const halfFired = findSpawnIsolationViolations(halfCompliant);
    expect(halfFired.length).toBe(1);
    expect(halfFired[0]?.missingKey).toBe('OK_TEST_SKIP_I18N_COMPILE');

    // Known limitation, pinned: the check is file-scoped, so a second
    // non-compliant spawn in a file whose first spawn carries both keys
    // goes undetected. If this assertion ever fails, the rule gained
    // per-block precision — update the docblock above.
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
    // `DocumentContext.tsx` owns `window.__activeEditor` via
    // `Object.defineProperty(window, '__activeEditor', { get: ... })` —
    // a getter-only accessor that derives the active editor from the
    // `active-editor.ts` registry (populated by `registerEditor` /
    // `unregisterEditor` in `TiptapEditor.tsx`). V8 rejects bare
    // assignment to a getter-only accessor: any `window.__activeEditor = x`
    // anywhere else throws `TypeError: Cannot set property __activeEditor
    // of #<Window> which has only a getter` on the next editor mount in
    // DEV, surfaced as an app-level error boundary crash.
    //
    // History: added a direct
    // assignment in TiptapEditor.tsx that was harmless in isolation. It
    // collided with main which introduced the
    // getter-only defineProperty. Neither branch alone had the bug — it
    // emerged in merge commit. Both sites touched different
    // files, so git produced zero conflict markers. Fixed by
    // deleting the direct-assignment useEffect.
    //
    // This test enforces the invariant at the static-scan layer so a
    // future contributor cannot reintroduce a second publication path
    // for the same global.
    const srcFiles = listAppSrcTsFiles();
    const directAssignPattern = /window\.__activeEditor\s*=/;
    // Exclude equality comparisons (`window.__activeEditor === editor`).
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
    // Precedent #34: innermost-wins uses `data-has-child-selected` written
    // by the SelectionStatePlugin, NOT a CSS `:has()` cascade. Reasons:
    //   1. Firefox rollout gaps (Safari, Chrome, and Firefox all support
    //      `:has()` now, but SSR environments + older browsers don't).
    //   2. Large-doc perf — `:has()` can be quadratic on deep nested trees.
    //   3. Debuggability — DOM `data-*` attrs are trivially inspectable;
    //      a CSS `:has()` cascade is not.
    //   4. SSR parity — plugin state survives without CSS support.
    //
    // Detection: match `:has(` on any line whose selector (i.e., the line
    // itself or the containing selector block) includes a selection-related
    // marker — `data-selected`, `data-has-child-selected`, or
    // `--selection-halo`. Other `:has()` usages (chrome hover innermost-
    // wins, slot hover, etc.) are out of scope — they don't govern
    // selection state.
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

      // Check the line itself AND the surrounding selector block (up to 3
      // lines back for multi-line selectors like `.foo:not(\n  :has(...))`).
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
    // the halo opacity
    // transition originally used bare `ease-out` but every other transition
    // in globals.css (7 of them) uses `var(--ease-out-strong)`. Silent
    // inconsistency regression is easy to re-introduce; guard statically.
    const cssPath = join(APP_SRC_DIR, 'globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    const lines = css.split('\n');

    // Find the halo-architecture section and look for a transition-opacity
    // or transition: opacity line that uses bare `ease-out`.
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

    // Match `transition:*ease-out` (bare, no leading `-` or `--ease`) on the
    // same line. Not a match: `var(--ease-out-strong)`, `ease-out-strong`.
    // Is a match: `transition: opacity 180ms ease-out;`.
    const violations: string[] = [];
    for (let i = haloStart; i < haloEnd; i++) {
      const line = lines[i] ?? '';
      if (!line.includes('transition')) continue;
      // Strip CSS custom property usage (`var(--ease-out-strong)`) so the
      // bare-`ease-out` detector doesn't false-positive on the correct form.
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

  /**
   * predev MUST honor OK_TEST_SKIP_I18N_COMPILE by routing the i18n compile
   * through `scripts/i18n-compile-unless-skipped.sh`.
   *
   * The spawn-isolation rule above asserts every e2e dev-server spawn SETS
   * OK_TEST_SKIP_I18N_COMPILE=1; this rule is its consumer-side complement —
   * predev must HONOR it. When predev calls the compile directly
   * (`bun run i18n:compile` / `lingui compile`), the env var is dead: every
   * concurrent `bun run dev` boot re-runs `biome format --write
   * src/locales/<locale>/messages.json` against the SHARED catalog. The write is
   * byte-identical but still bumps mtime, so Vite full-page-reloads every
   * connected browser (`[vite] page reload src/locales/en/messages.json`),
   * destroying any in-flight `page.evaluate`. The long, evaluate-dense
   * `frozen-table-headers.e2e.ts` tests were the canary (context-destroyed
   * evaluates at ~22% under --workers=4 --repeat-each). The guard was wired
   * and silently reverted by an unrelated PR re-introducing the
   * direct call — this rule makes that exact regression hard-fail.
   *
   */
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
