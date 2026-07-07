/**
 * Static-analysis regression guard. Parses every `tests/smoke/*.e2e.ts`
 * and fails if any file contains:
 *   (1) an unbounded `await app.close()` call site, or
 *   (2) a local `closeAppSafely` function definition.
 *
 * Why this guard exists: Playwright's `ElectronApplication.close()`
 * delegates to processLauncher's `gracefullyClose()`, which awaits
 * `attemptToGracefullyClose` WITHOUT a timeout. When the Electron Helper
 * subprocess is unresponsive (XPC errors, slow Cache compaction, hung
 * utility process draining CRDT state under macOS-CI runner load),
 * `app.close()` hangs without bound. A test-body finally block that
 * awaits it propagates the hang through the test's outer 150 s timeout,
 * producing 3× retry failures and ~7 minutes of wasted runner time per
 * occurrence.
 *
 * The fixture in `_helpers/smoke-test.ts` already runs a bounded
 * `closeAppBounded(proc)` teardown on every registered Electron app —
 * but Playwright runs the test body's `finally` BEFORE fixture teardowns,
 * so an unbounded `await app.close()` in the test body executes first
 * and shadows the bounded fixture path. The contract this test pins:
 *
 *   The FIRST cleanup pass that runs after a smoke test body completes
 *   (success, assertion failure, timeout, or interruption) must be
 *   bounded. The bounded path lives in the fixture; the test body must
 *   not introduce an unbounded pass ahead of it.
 *
 * Mirrors the pattern of `parse-timeouts.test.ts` (same `_helpers/` dir):
 * pure file-text parsing using the length-preserving comment+string
 * stripper from `parse-timeouts.ts`, no external AST library. The
 * stripper blanks out comments and string-literal contents so commented
 * `// await app.close()` references in docblocks (e.g. `deep-link.e2e.ts`'s
 * `app.close() resolves when…` documentation) do not produce false
 * positives.
 *
 * Post-migration state: every cleanup site routes through the bounded
 * fixture or an explicit bounded primitive. The failure message
 * enumerates every violation site (file:line + verbatim source snippet)
 * so any future re-introduction has a complete inventory to walk.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsAndStrings } from './parse-timeouts';

const SMOKE_DIR = join(__dirname, '..');

type ViolationKind = 'await-app-close' | 'closeAppSafely-definition';

interface Violation {
  file: string;
  line: number;
  kind: ViolationKind;
  snippet: string;
}

interface SmokeFile {
  abs: string;
  rel: string;
}

function listSmokeFiles(): SmokeFile[] {
  return readdirSync(SMOKE_DIR)
    .filter((f) => f.endsWith('.e2e.ts'))
    .sort()
    .map((f) => ({ abs: join(SMOKE_DIR, f), rel: f }));
}

function lineNumberAt(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i += 1) {
    if (src[i] === '\n') n += 1;
  }
  return n;
}

function snippetAt(rawSrc: string, idx: number): string {
  const lineStart = rawSrc.lastIndexOf('\n', idx - 1) + 1;
  const nextNewline = rawSrc.indexOf('\n', idx);
  const lineEnd = nextNewline === -1 ? rawSrc.length : nextNewline;
  return rawSrc.slice(lineStart, lineEnd).trim();
}

/**
 * Pure detection function. Takes raw source + a label (filename for
 * reporting); returns violations. Extracted for unit-testability — the
 * disk-reading wrapper `findViolations` delegates to this so the
 * synthetic-input tests below can exercise the regex + stripper logic
 * without filesystem fixtures.
 */
function findViolationsInSource(rawSrc: string, fileLabel: string): Violation[] {
  // Length-preserving strip — line numbers in `stripped` match `rawSrc`. Blanks
  // out comment + string-literal contents so commented-out call sites and
  // doc-block prose mentioning `app.close()` are not flagged.
  const stripped = stripCommentsAndStrings(rawSrc);
  const out: Violation[] = [];

  // Rule 1 — direct `await app.close()` call site. Matches `app`, `app1`,
  // `app2`, etc., AND the optional-chaining `app?.close()` form (a
  // defensive null-check pattern a future contributor might reach for).
  // The conventional ElectronApplication-typed variable name in this
  // codebase is `app`, but qa-create-new-extended.e2e.ts uses
  // `app1`/`app2` for its multi-launch test (the highest-risk regression
  // site since it's the only test that needs an explicit inline close).
  // The `app\w*` stem still avoids false positives against `page.close()`
  // or `browser.close()` (different word stems).
  const awaitAppCloseRe = /\bawait\s+app\w*\s*\??\.\s*close\s*\(/g;
  for (const m of stripped.matchAll(awaitAppCloseRe)) {
    const idx = m.index ?? 0;
    out.push({
      file: fileLabel,
      line: lineNumberAt(rawSrc, idx),
      kind: 'await-app-close',
      snippet: snippetAt(rawSrc, idx),
    });
  }

  // Rule 2 — local `closeAppSafely` function definition. The name is
  // historically associated with the unbounded `try { await app.close() }
  // catch {}` pattern. Removing
  // the name forces every cleanup site to consciously route through the
  // fixture's bounded teardown or the shared `closeAppBounded`
  // primitive — making future re-introduction of the anti-pattern a
  // deliberate, reviewable choice rather than a muscle-memory paste.
  const closeAppSafelyDefRe = /\b(?:async\s+)?function\s+closeAppSafely\s*\(/g;
  for (const m of stripped.matchAll(closeAppSafelyDefRe)) {
    const idx = m.index ?? 0;
    out.push({
      file: fileLabel,
      line: lineNumberAt(rawSrc, idx),
      kind: 'closeAppSafely-definition',
      snippet: snippetAt(rawSrc, idx),
    });
  }

  return out;
}

function findViolations(file: SmokeFile): Violation[] {
  return findViolationsInSource(readFileSync(file.abs, 'utf8'), file.rel);
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return '';
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = byFile.get(v.file) ?? [];
    arr.push(v);
    byFile.set(v.file, arr);
  }
  const lines: string[] = [
    `Found ${violations.length} unbounded-cleanup violation(s) across ${byFile.size} smoke file(s):`,
    '',
  ];
  for (const [file, vs] of byFile) {
    lines.push(`  ${file}:`);
    for (const v of vs.sort((a, b) => a.line - b.line)) {
      lines.push(`    L${v.line} (${v.kind}): ${v.snippet}`);
    }
  }
  lines.push('');
  lines.push('Every cleanup pass in a smoke `.e2e.ts` test body MUST be bounded.');
  lines.push('The `captureStderrFor` fixture in `_helpers/smoke-test.ts` already runs');
  lines.push('`closeAppBounded(proc, { gracefulMs: 5_000 })` on every registered app.');
  lines.push('Test bodies should NOT introduce an unbounded `await app.close()` ahead');
  lines.push("of the fixture teardown — Playwright runs the body's `finally` first,");
  lines.push('and an unbounded await there hangs through the 150 s outer timeout.');
  lines.push('See `_helpers/electron-cleanup.ts` for the bounded primitive contract.');
  return lines.join('\n');
}

describe('no-unbounded-app-close — smoke-file call-site enforcement', () => {
  test('every smoke .e2e.ts file routes cleanup through the bounded primitive (no `await app.close()`, no `closeAppSafely` defs)', () => {
    const files = listSmokeFiles();
    // Sanity: at least one smoke file must exist. If the smoke suite is
    // ever moved or the dir layout changes, this assertion makes the
    // regression visible immediately instead of silently passing with
    // zero-violation against zero files.
    expect(files.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      violations.push(...findViolations(file));
    }

    // Surface the full inventory in the assertion message so a fixer has
    // every file:line in one place without re-running the test per file.
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

/**
 * Detection-logic tests. Without these, the only failure mode of the
 * outer guard is silent false-pass: if `stripCommentsAndStrings` were to
 * mis-strip a real call site, or if `awaitAppCloseRe` were to regress,
 * the outer test stays GREEN while the enforcement contract is silently
 * broken. These pure-input tests pin the regex + stripper composition
 * against synthetic violations so a regex/stripper regression fails
 * loudly here instead of slipping through into a future PR.
 */
describe('findViolationsInSource — detection logic', () => {
  test('detects bare `await app.close()`', () => {
    const src = `
      test('x', async () => {
        const app = await launchApp(tmpHome);
        try { /* body */ } finally { await app.close(); }
      });
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('await-app-close');
  });

  test('detects `app1.close()` and `app2.close()` (multi-launch variants)', () => {
    const src = `
      const app1 = await launchApp(h1);
      await app1.close();
      const app2 = await launchApp(h2);
      await app2.close();
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations.length).toBe(2);
    expect(violations.every((v) => v.kind === 'await-app-close')).toBe(true);
  });

  test('detects optional-chaining `await app?.close()`', () => {
    const src = `await app?.close();`;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('await-app-close');
  });

  test('does NOT detect `await app.close()` inside a line comment', () => {
    const src = `
      // await app.close(); // intentionally commented for documentation
      const x = 1;
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations).toEqual([]);
  });

  test('does NOT detect `await app.close()` inside a block comment', () => {
    const src = `
      /*
       * The legacy pattern was: await app.close(); — now removed.
       */
      const x = 1;
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations).toEqual([]);
  });

  test('does NOT detect `await app.close()` inside a string literal', () => {
    const src = `const docExample = "await app.close()";`;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations).toEqual([]);
  });

  test('does NOT flag `await page.close()` or `await browser.close()` (different word stems)', () => {
    const src = `
      await page.close();
      await browser.close();
      await editor.close();
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations).toEqual([]);
  });

  test('detects `async function closeAppSafely(...)` definition', () => {
    const src = `
      async function closeAppSafely(app: ElectronApplication | null) {
        if (app === null) return;
        try { await app.close(); } catch {}
      }
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    // Two violations: the definition (Rule 2) AND the inner await app.close() (Rule 1)
    expect(violations.length).toBe(2);
    expect(violations.some((v) => v.kind === 'closeAppSafely-definition')).toBe(true);
    expect(violations.some((v) => v.kind === 'await-app-close')).toBe(true);
  });

  test('detects non-async `function closeAppSafely(...)` definition', () => {
    // Pins the `(?:async\\s+)?` optional group in Rule 2. All 6 historical
    // call sites used the async form, but a future hand-written
    // sync wrapper (e.g., for a CommonJS module) should still trip the
    // guard — without this case, a regression removing the `?` from
    // the regex's optional group would go undetected.
    const src = `function closeAppSafely(proc) { /* no async, no await */ }`;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('closeAppSafely-definition');
  });

  test('reports correct line numbers for violations', () => {
    const src = `line 1\nline 2\nawait app.close();\nline 4`;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations.length).toBe(1);
    expect(violations[0]?.line).toBe(3);
  });
});
