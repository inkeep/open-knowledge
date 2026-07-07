import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_POLISH_DIR = import.meta.dirname;

describe('engine invariants (D2 LOCKED primitive-set enforcement)', () => {
  // Runtime source-mode behavior can prove that today's decorations render,
  // but it cannot prove the absence of these forbidden CodeMirror primitives
  // across future files in the source-polish submodule. This static guard is
  // intentionally retained as an architectural allowlist-by-absence check.
  const tsFiles = readdirSync(SOURCE_POLISH_DIR).filter(
    (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'),
  );

  test('no Decoration.replace in source-polish submodule', () => {
    for (const file of tsFiles) {
      const content = readFileSync(join(SOURCE_POLISH_DIR, file), 'utf-8');
      expect(content).not.toContain('Decoration.replace');
    }
  });

  test('no atomicRanges in source-polish submodule', () => {
    for (const file of tsFiles) {
      const content = readFileSync(join(SOURCE_POLISH_DIR, file), 'utf-8');
      expect(content).not.toContain('atomicRanges');
    }
  });
});
