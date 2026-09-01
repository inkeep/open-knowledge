import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { classifyHostEntry } from './skill-migrate.ts';
import { classifyInPlaceDest } from './skill-projection.ts';

let root: string;
let canonical: string;
let canonicalHash: string;

function writeSkill(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: demo-skill\ndescription: d\n---\n\n${body}\n`,
    'utf-8',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-classifier-eq-'));
  canonical = join(root, 'canonical');
  writeSkill(canonical, 'canonical body');
  canonicalHash = parseSkillDir(canonical)?.contentHash ?? '';
  expect(canonicalHash).not.toBe('');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function classifyBoth(dest: string): { projection: string; migration: string } {
  const host = classifyHostEntry(dest, realpathSync(canonical), canonicalHash);
  return {
    projection: classifyInPlaceDest(dest, canonical, canonicalHash),
    migration: host.kind === 'occupied' ? `occupied:${host.by}` : host.kind,
  };
}

describe('the two classifiers AGREE', () => {
  test('nothing at the path', () => {
    expect(classifyBoth(join(root, 'nope'))).toEqual({
      projection: 'absent',
      migration: 'absent',
    });
  });

  test('a live symlink resolving to the reference bundle', () => {
    const dest = join(root, 'link-to-canonical');
    symlinkSync(canonical, dest, 'dir');
    expect(classifyBoth(dest)).toEqual({
      projection: 'link-to-canonical',
      migration: 'store-link',
    });
  });

  test('a real directory whose content hash matches', () => {
    const dest = join(root, 'same-copy');
    writeSkill(dest, 'canonical body');
    expect(classifyBoth(dest)).toEqual({ projection: 'same-copy', migration: 'same-copy' });
  });

  test('a real directory whose content differs', () => {
    const dest = join(root, 'fork');
    writeSkill(dest, 'hand-edited, do not clobber');
    expect(classifyBoth(dest)).toEqual({
      projection: 'different',
      migration: 'occupied:different',
    });
  });

  test('a stray file where a bundle dir was expected', () => {
    const dest = join(root, 'notes.bak');
    writeFileSync(dest, 'not a skill', 'utf-8');
    expect(classifyBoth(dest)).toEqual({
      projection: 'different',
      migration: 'occupied:different',
    });
  });
});

describe('the two classifiers DISAGREE, deliberately', () => {
  test('a DANGLING symlink: projection removes it, migration leaves it alone', () => {
    const dest = join(root, 'dangling');
    symlinkSync(join(root, 'gone'), dest, 'dir');
    expect(classifyBoth(dest)).toEqual({
      projection: 'link',
      migration: 'occupied:foreign-link',
    });
  });

  test('a symlink resolving SOMEWHERE ELSE: projection removes it, migration leaves it alone', () => {
    const other = join(root, 'other-bundle');
    writeSkill(other, 'someone else');
    const dest = join(root, 'points-elsewhere');
    symlinkSync(other, dest, 'dir');
    expect(classifyBoth(dest)).toEqual({ projection: 'link', migration: 'occupied:foreign-link' });
  });

  test('the reference bundle reached by another path: only projection names it', () => {
    const aliasParent = join(root, 'alias');
    symlinkSync(root, aliasParent, 'dir');
    const dest = join(aliasParent, 'canonical');
    expect(classifyBoth(dest)).toEqual({
      projection: 'canonical-dir',
      migration: 'same-copy',
    });
  });
});

describe('the reference bundle is gone', () => {
  test('a byte-identical real dir reads as `different` for BOTH once the reference is unreadable', () => {
    const dest = join(root, 'same-copy-orphaned');
    writeSkill(dest, 'canonical body');
    expect(classifyBoth(dest)).toEqual({ projection: 'same-copy', migration: 'same-copy' });

    const canonicalReal = realpathSync(canonical);
    rmSync(canonical, { recursive: true, force: true });
    expect(classifyInPlaceDest(dest, canonical, canonicalHash)).toBe('different');
    expect(classifyHostEntry(dest, canonicalReal, canonicalHash)).toEqual({
      kind: 'occupied',
      by: 'different',
    });
  });
});

describe('projection-only outcomes stay reachable', () => {
  test('`canonical-dir` when dest IS the canonical path verbatim', () => {
    expect(classifyInPlaceDest(canonical, canonical, canonicalHash)).toBe('canonical-dir');
  });
});
