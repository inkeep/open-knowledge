import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyDirSync } from './copy-dir.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ok-copy-dir-'));
}

/** A pack-skill-shaped source: a root bundle with a nested member skill. */
function seedSource(): string {
  const src = join(tmpDir(), 'pack');
  mkdirSync(join(src, 'references'), { recursive: true });
  mkdirSync(join(src, 'member'), { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), 'root\n');
  writeFileSync(join(src, 'README.md'), 'readme\n');
  writeFileSync(join(src, 'references', 'deep.md'), 'deep\n');
  writeFileSync(join(src, 'member', 'SKILL.md'), 'member\n');
  return src;
}

describe('copyDirSync', () => {
  test('copies the tree recursively, creating the destination', () => {
    const src = seedSource();
    const dest = join(tmpDir(), 'out');

    copyDirSync(src, dest);

    expect(readdirSync(dest).sort()).toEqual(['README.md', 'SKILL.md', 'member', 'references']);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('root\n');
    expect(readFileSync(join(dest, 'references', 'deep.md'), 'utf-8')).toBe('deep\n');
    expect(readFileSync(join(dest, 'member', 'SKILL.md'), 'utf-8')).toBe('member\n');
  });

  test('filter skips an entry and, for a directory, its whole subtree', () => {
    const src = seedSource();
    const dest = join(tmpDir(), 'out');
    const excluded = ['member', 'README.md'];

    copyDirSync(src, dest, {
      filter: (path) => !excluded.some((entry) => path === join(src, entry)),
    });

    expect(readdirSync(dest).sort()).toEqual(['SKILL.md', 'references']);
    // The listing alone would pass even if descent into an included directory
    // were skipped — `mkdir` creates it on entry regardless.
    expect(readFileSync(join(dest, 'references', 'deep.md'), 'utf-8')).toBe('deep\n');
  });

  test('merges into an existing destination without failing', () => {
    const src = seedSource();
    const dest = join(tmpDir(), 'out');
    mkdirSync(join(dest, 'references'), { recursive: true });
    writeFileSync(join(dest, 'references', 'stale.md'), 'stale\n');

    copyDirSync(src, dest);

    expect(readFileSync(join(dest, 'references', 'deep.md'), 'utf-8')).toBe('deep\n');
    // Callers own freshness — the copy itself never removes what it did not write.
    expect(readFileSync(join(dest, 'references', 'stale.md'), 'utf-8')).toBe('stale\n');
  });
});
