/**
 * Equivalence table for the two skill path classifiers.
 *
 * `classifyInPlaceDest` (projection) and `classifyHostEntry` (store migration)
 * answer the same question — "what is sitting at this path?" — through the same
 * skeleton: lstat → symlink? → realpath → hash-compare. They are NOT the same
 * function, and the places they disagree are precisely the places a naive merge
 * would delete something it was written to preserve.
 *
 * This suite drives BOTH over one matrix of on-disk shapes and pins every
 * verdict. It was written against the two independent implementations before
 * they shared anything, so the unification was provably behavior-preserving
 * rather than hopefully so; it stays as the regression pin. Both now delegate
 * the walk to `inspectSkillPathEntry` and keep only their own mapping on top —
 * if a change collapses those two mappings, the disagreement rows below fail.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { beforeEach, describe, expect, test } from 'vitest';
import { classifyHostEntry } from './skill-migrate.ts';
import { classifyInPlaceDest } from './skill-projection.ts';

let root: string;
/** The reference bundle both classifiers are asked about. */
let canonical: string;
let canonicalHash: string;

/** The frontmatter `name` is FIXED, not derived from the directory: the hash
 *  covers SKILL.md's bytes, so deriving it would make every copy differ by
 *  construction and the same-content row could never be exercised. */
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

/** Both classifiers, over the same path, in one call. `occupied` reports its
 *  `by` discriminator too — that is the whole reason the payload exists. */
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

// These are the rows that make a shared primitive need a PER-CALLER mapping.
// Collapsing either one is a data-loss bug, not a simplification.
describe('the two classifiers DISAGREE, deliberately', () => {
  test('a DANGLING symlink: projection removes it, migration leaves it alone', () => {
    const dest = join(root, 'dangling');
    symlinkSync(join(root, 'gone'), dest, 'dir');
    expect(classifyBoth(dest)).toEqual({
      // generic removable link — projection replaces it with a copy
      projection: 'link',
      // migration defers: an OK projection whose store source is about to move
      // would NOT dangle, so a dangling one belongs to something else and
      // reconcile's orphan pass owns it
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

  // Reached when a parent component is a symlink, so lstat sees a DIRECTORY
  // while realpath resolves onto the reference bundle itself.
  test('the reference bundle reached by another path: only projection names it', () => {
    const aliasParent = join(root, 'alias');
    symlinkSync(root, aliasParent, 'dir');
    const dest = join(aliasParent, 'canonical');
    expect(classifyBoth(dest)).toEqual({
      // never touched — this IS the skill
      projection: 'canonical-dir',
      // migration has no such outcome; by construction store and host dirs are
      // distinct paths, and it reads this as a hash match
      migration: 'same-copy',
    });
  });
});

describe('projection-only outcomes stay reachable', () => {
  test('`canonical-dir` when dest IS the canonical path verbatim', () => {
    expect(classifyInPlaceDest(canonical, canonical, canonicalHash)).toBe('canonical-dir');
  });
});
