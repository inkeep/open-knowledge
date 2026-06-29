
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const APP_ROOT = join(import.meta.dir, '..', '..');

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
    expect(factoryHasActualSpread('() => ({ useDocumentContext: () => ({}) })')).toBe(false);
    expect(factoryHasActualSpread('() => ({ wrap: (...args) => fn(...args) })')).toBe(false);
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
