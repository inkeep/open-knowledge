import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  compileTagSurfaces,
  parseTagSurfaces,
  SUPPORTED_TAG_SURFACE_MAJOR,
  TAG_SURFACE_FILENAME,
  TagSurfaceError,
  tagSurfaceMatcherForRoot,
} from './tag-scope.mjs';

const VOCABULARY = ['@alpha-mark', '@beta-mark'];

const SURFACES = [
  {
    id: 'declarations',
    tags: ['@alpha-mark', '@beta-mark'],
    include: ['src/audited/**/*.ts'],
    exclude: ['**/*.contract.ts'],
  },
  {
    id: 'anchors',
    tags: ['@beta-mark'],
    include: ['src/engine/**/*.ts'],
    exclude: ['**/*.test.ts'],
  },
];

const roots = [];
const rootWith = (contents) => {
  const root = mkdtempSync(join(tmpdir(), 'no-comments-tag-scope-'));
  roots.push(root);
  if (contents !== null) writeFileSync(join(root, TAG_SURFACE_FILENAME), contents);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('a tag is admitted where a surface that reads it covers the path', () => {
  const tagsAt = compileTagSurfaces(SURFACES, { vocabulary: VOCABULARY });

  test('a path inside a surface admits exactly that surface vocabulary', () => {
    expect(tagsAt('src/audited/round-trip.ts')).toEqual(['@alpha-mark', '@beta-mark']);
    expect(tagsAt('src/engine/pipeline.ts')).toEqual(['@beta-mark']);
  });

  test('a path no surface covers admits nothing', () => {
    expect(tagsAt('src/other/helper.ts')).toEqual([]);
  });

  test('a surface exclude wins over its own include', () => {
    expect(tagsAt('src/audited/wire.contract.ts')).toEqual([]);
    expect(tagsAt('src/engine/pipeline.test.ts')).toEqual([]);
  });

  test('overlapping surfaces union their tags rather than shadowing', () => {
    const overlapping = compileTagSurfaces(
      [
        { id: 'a', tags: ['@alpha-mark'], include: ['src/**/*.ts'], exclude: [] },
        { id: 'b', tags: ['@beta-mark'], include: ['src/engine/**/*.ts'], exclude: [] },
      ],
      { vocabulary: VOCABULARY },
    );

    expect(overlapping('src/engine/pipeline.ts')).toEqual(['@alpha-mark', '@beta-mark']);
  });

  test('the live vocabulary bounds the artifact, so a retired tag stays retired', () => {
    const retired = compileTagSurfaces(
      [{ id: 'a', tags: ['@alpha-mark', '@retired'], include: ['src/**/*.ts'], exclude: [] }],
      { vocabulary: VOCABULARY },
    );

    expect(retired('src/audited/round-trip.ts')).toEqual(['@alpha-mark']);
  });
});

describe('a malformed surface artifact is loud, and an absent one is the empty scope', () => {
  const parse = (text) => parseTagSurfaces(text, { surfacePath: '/repo/artifact.json' });

  test('an unreadable artifact names the file', () => {
    expect(() => parse('{')).toThrow(TagSurfaceError);
    expect(() => parse('{')).toThrow('/repo/artifact.json');
  });

  test('a version this predicate does not read names the key', () => {
    const ahead = SUPPORTED_TAG_SURFACE_MAJOR + 1;

    expect(() => parse(`{"version":${ahead},"surfaces":[]}`)).toThrow(
      new RegExp(`version.*${ahead}`, 's'),
    );
  });

  test('an artifact with no surface is refused rather than read as "scope nothing"', () => {
    expect(() => parse('{"version":1,"surfaces":[]}')).toThrow(/at least one consumer surface/);
  });

  test('a surface missing its globs names the entry', () => {
    expect(() => parse('{"version":1,"surfaces":[{"id":"a","tags":["@beta-mark"]}]}')).toThrow(
      /surfaces\[0\]\.include/,
    );
  });

  test('a root carrying no artifact admits no tag anywhere', () => {
    expect(tagSurfaceMatcherForRoot(rootWith(null))('src/audited/round-trip.ts')).toEqual([]);
  });

  test('a root carrying a broken artifact throws instead of silently admitting nothing', () => {
    const root = rootWith('{"version":1,"surfaces":[{"id":"a"}]}');

    expect(() => tagSurfaceMatcherForRoot(root)).toThrow(TagSurfaceError);
  });
});

const privateTestGlob = (dir, stem) => `${dir}/${stem}.private.test.ts`;

describe('the tag artifact is held to the same glob grammar as the scope config', () => {
  const parse = (text) => parseTagSurfaces(text, { surfacePath: '/repo/artifact.json' });
  const withGlob = (glob) =>
    JSON.stringify({
      version: SUPPORTED_TAG_SURFACE_MAJOR,
      surfaces: [{ id: 'a', tags: ['@alpha-mark'], include: [glob], exclude: [] }],
    });

  test('a surface glob the matcher cannot compile is refused by name, not as a raw Error', () => {
    expect(() => parse(withGlob('packages/{a,b}/**'))).toThrow(TagSurfaceError);
    expect(() => parse(withGlob('packages/{a,b}/**'))).toThrow(/does not implement/);
    expect(() => parse(withGlob('packages/(x)/**'))).toThrow(TagSurfaceError);
  });

  test('the glob shapes the generator actually emits still compile', () => {
    expect(() => parse(withGlob('packages/app/tests/fidelity/**/*.test.ts'))).not.toThrow();
    expect(() => parse(withGlob(privateTestGlob('packages/core/src/markdown', '*.precision')))).not.toThrow();
  });
});
