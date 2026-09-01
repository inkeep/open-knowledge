import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const APP_SRC = join(import.meta.dir, '..', '..', 'src');
const RESOLVER_PATH = join(APP_SRC, 'components', 'ConflictResolver.tsx');

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTsx(full);
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.dom.test.tsx')
    ) {
      yield full;
    }
  }
}

describe('D21 — ConflictResolver deletion regression guard', () => {
  test('packages/app/src/components/ConflictResolver.tsx does not exist', () => {
    let exists = true;
    try {
      statSync(RESOLVER_PATH);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test('no source file imports ConflictResolver or references its prop-chain names', () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of walkTsx(APP_SRC)) {
      const src = readFileSync(file, 'utf-8');
      if (/\bConflictResolver\b/.test(src)) {
        offenders.push({ file, match: 'ConflictResolver' });
      }
      if (/\bonOpenConflictResolver\b/.test(src)) {
        offenders.push({ file, match: 'onOpenConflictResolver' });
      }
      if (/\bonOpenResolver\b/.test(src)) {
        offenders.push({ file, match: 'onOpenResolver' });
      }
    }
    expect(offenders).toEqual([]);
  });
});
