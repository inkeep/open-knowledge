import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../../test-support/test-only-source-file.mjs';
import { SOURCE_POLISH_SCAN_ROOT } from './engine-invariants.reads';

const SOURCE_POLISH_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  SOURCE_POLISH_SCAN_ROOT,
);

describe('engine invariants (D2 LOCKED primitive-set enforcement)', () => {
  const tsFiles = readdirSync(SOURCE_POLISH_DIR).filter(
    (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !isTestOnlySourceFile(f),
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
