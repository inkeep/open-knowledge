
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

function findViolationsInSource(rawSrc: string, fileLabel: string): Violation[] {
  const stripped = stripCommentsAndStrings(rawSrc);
  const out: Violation[] = [];

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
    expect(files.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      violations.push(...findViolations(file));
    }

    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

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
      const x = 1;
    `;
    const violations = findViolationsInSource(src, 'synthetic.e2e.ts');
    expect(violations).toEqual([]);
  });

  test('does NOT detect `await app.close()` inside a block comment', () => {
    const src = `
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
    expect(violations.length).toBe(2);
    expect(violations.some((v) => v.kind === 'closeAppSafely-definition')).toBe(true);
    expect(violations.some((v) => v.kind === 'await-app-close')).toBe(true);
  });

  test('detects non-async `function closeAppSafely(...)` definition', () => {
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
