/**
 * Meta-test: every `mock.module` factory in a plain (non-.dom) app test file
 * must spread the real module (`...actual`) or carry an explicit allowlist
 * entry below.
 *
 * Bun's `mock.module` registry is process-global and never restored between
 * test files (oven-sh/bun#12823 closed-as-intended). When a factory registers
 * BEFORE the real module loads, the registry entry's export table contains
 * ONLY the factory's keys — any later file importing an omitted export hits a
 * link error naming the REAL file path. Failure order follows the runner
 * filesystem's readdir order: deterministic per job (defeating fresh-process
 * flake retries), re-rolled per runner. Detonation case: a partial
 * `@/editor/DocumentContext` mock (1 of its exports) broke
 * `EditorArea.test.ts`'s module-load smoke on two PR runs while passing
 * everywhere else.
 *
 * The spread-real pattern fixes both halves: the static import pre-loads the
 * real module (so bun mutates the namespace in place instead of synthesizing
 * a partial one), and the spread keeps every unmocked export bound.
 *
 * Scope: plain `*.test.ts(x)` under src/ — the files sharing the unit-task
 * process. `*.dom.test.tsx` files run in the separate test:dom process and
 * carry the same class among themselves; expanding this sweep to them is
 * tracked (App.dom.test.tsx alone holds ~23 factories).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const APP_ROOT = join(import.meta.dir, '..', '..');

/**
 * Files allowed to keep a partial factory, with the reason it is safe.
 * Adding an entry requires the same justification bar as a drift-allowlist
 * addition: the omitted exports must have NO other importer in the unit-task
 * process, or the file must guarantee the real module is loaded first.
 */
const ALLOWLIST: Record<string, string> = {
  'src/components/EditorActivityPool.lazy.test.ts::@/editor/SourceEditor':
    'The factory COUNTS module loads to assert lazy non-loading — spreading the real module would ' +
    "load it and defeat the test. Safe: the factory provides SourceEditor, the module's only " +
    'value export consumed by plain tests in this process.',
};

function extractMockModuleCalls(src: string): Array<{ specifier: string; factory: string }> {
  const calls: Array<{ specifier: string; factory: string }> = [];
  const re = /mock\.module\(\s*(['"])([^'"]+)\1\s*,/g;
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    // Capture the factory body: scan forward to the matching close of the
    // mock.module(...) call by paren depth. Good enough for the repo's
    // factory shapes (object-literal arrow functions).
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    calls.push({ specifier: m[2] ?? '', factory: src.slice(re.lastIndex, i) });
    m = re.exec(src);
  }
  return calls;
}

/**
 * Does this factory body spread the real module under the `...actual*` naming
 * convention every fixed site uses? Deliberately requires the `actual` prefix:
 * a bare any-identifier spread would let rest params (`...args`) or unrelated
 * object spreads (`...localConfig`) satisfy the guard and silently disable it.
 */
function factoryHasActualSpread(factory: string): boolean {
  return /\.\.\.\s*actual[A-Za-z_$]?[\w$]*/.test(factory);
}

describe('mock.module factory completeness (process-global leak guard)', () => {
  test('every plain-test factory spreads the real module or is allowlisted', async () => {
    const glob = new Glob('src/**/*.test.{ts,tsx}');
    const violations: string[] = [];
    for await (const file of glob.scan(APP_ROOT)) {
      if (file.includes('.dom.test.')) continue;
      const abs = join(APP_ROOT, file);
      const rel = relative(APP_ROOT, abs);
      const src = readFileSync(abs, 'utf-8');
      if (!src.includes('mock.module(')) continue;
      for (const call of extractMockModuleCalls(src)) {
        const hasSpread = factoryHasActualSpread(call.factory);
        const allowKey = `${rel}::${call.specifier}`;
        if (!hasSpread && !(allowKey in ALLOWLIST)) {
          violations.push(
            `${rel} mocks '${call.specifier}' with a partial factory (no \`...actual*\`-convention spread). ` +
              `Spread the real module (static-import it as actual, then \`...actual\` first in the factory) ` +
              `or add '${allowKey}' to ALLOWLIST with a safety rationale.`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('guard self-test (bidirectional + planted-positive)', () => {
  // This guard passes by finding NOTHING in the live tree, so it can rot into
  // a vacuous no-op if the extractor or the spread predicate is weakened.
  // These fixtures pin that it still FIRES (planted-positive) and does not
  // over-fire (adjacent negatives), exercising the SAME functions the guard
  // uses so the two cannot drift apart.

  test('extractMockModuleCalls: finds every call (planted-positive), nothing in clean source', () => {
    const twoCalls = [
      "mock.module('sonner', () => ({ toast }));",
      "mock.module('@/editor/DocumentContext', () => ({ useDocumentContext: () => ({}) }));",
    ].join('\n');
    expect(extractMockModuleCalls(twoCalls).map((c) => c.specifier)).toEqual([
      'sonner',
      '@/editor/DocumentContext',
    ]);
    expect(extractMockModuleCalls('const x = 1; await import("./y");')).toEqual([]);
  });

  test('factoryHasActualSpread: accepts ...actual* spreads (must-fire-true)', () => {
    expect(factoryHasActualSpread('() => ({ ...actualSonner, toast })')).toBe(true);
    expect(factoryHasActualSpread('() => ({ ...actual, useDocumentContext: () => ({}) })')).toBe(
      true,
    );
    expect(
      factoryHasActualSpread('() => ({\n  ...actualNextThemes,\n  useTheme: () => ({}),\n})'),
    ).toBe(true);
  });

  test('factoryHasActualSpread: rejects partial and non-actual spreads (adjacent negatives)', () => {
    // partial factory — the detonation class
    expect(factoryHasActualSpread('() => ({ useDocumentContext: () => ({}) })')).toBe(false);
    // rest param in the body — the exact false-positive the tightened regex closes
    expect(factoryHasActualSpread('() => ({ wrap: (...args) => fn(...args) })')).toBe(false);
    // unrelated object spread — satisfies a bare /.../ but not the ...actual* convention
    expect(factoryHasActualSpread('() => ({ ...localConfig, toast })')).toBe(false);
  });

  test('end-to-end: a partial factory is flagged, an ...actual factory is not', () => {
    const flagged = (src: string) =>
      extractMockModuleCalls(src).filter((c) => !factoryHasActualSpread(c.factory)).length;
    expect(flagged("mock.module('sonner', () => ({ toast: { error() {} } }));")).toBe(1);
    expect(
      flagged("mock.module('sonner', () => ({ ...actualSonner, toast: { error() {} } }));"),
    ).toBe(0);
  });
});
