import { describe, expect, test } from 'vitest';
import { classifyImageTargetExistence } from './image-target-existence';

describe('classifyImageTargetExistence', () => {
  test('server-absolute src present in the referenced-asset set is exists', () => {
    const state = classifyImageTargetExistence(
      '/images/cat.png',
      '',
      new Set(['images/cat.png']),
      undefined,
    );
    expect(state).toBe('exists');
  });

  test('server-absolute src present only in the tracked-file set is exists', () => {
    // An unreferenced image on disk surfaces as a `kind:'file'` row, not a
    // referenced asset — the union of both partitions is the existence oracle.
    const state = classifyImageTargetExistence(
      '/pics/loose.png',
      '',
      new Set(),
      new Set(['pics/loose.png']),
    );
    expect(state).toBe('exists');
  });

  test('project-local src in neither partition is missing', () => {
    const state = classifyImageTargetExistence(
      '/images/ghost.png',
      '',
      new Set(['images/cat.png']),
      new Set(['data/example.csv']),
    );
    expect(state).toBe('missing');
  });

  test('existence match is case-insensitive, mirroring link-chip resolution', () => {
    const state = classifyImageTargetExistence(
      '/Images/Cat.PNG',
      '',
      new Set(['images/cat.png']),
      undefined,
    );
    expect(state).toBe('exists');
  });

  test('external URL is unknown — absence from the inventory proves nothing', () => {
    expect(
      classifyImageTargetExistence('https://cdn.example.com/a.png', '', new Set(), new Set()),
    ).toBe('unknown');
  });

  test('protocol-relative src is unknown', () => {
    expect(classifyImageTargetExistence('//host/a.png', '', new Set(), new Set())).toBe('unknown');
  });

  test('anchor-only src is unknown', () => {
    expect(classifyImageTargetExistence('#section', '', new Set(), new Set())).toBe('unknown');
  });

  test('traversal escape past the content root is unknown, not missing', () => {
    // A `..` that pops above the root resolves to no project path, so it must
    // not be reported as a missing project-local file.
    expect(classifyImageTargetExistence('../../../etc/passwd.png', '', new Set(), new Set())).toBe(
      'unknown',
    );
  });

  test('a doc-relative src resolves against the source doc directory', () => {
    // The rare un-normalized relative form still classifies correctly when a
    // source doc is supplied.
    expect(
      classifyImageTargetExistence(
        './cat.png',
        'folder/note',
        new Set(['folder/cat.png']),
        undefined,
      ),
    ).toBe('exists');
    expect(
      classifyImageTargetExistence(
        './ghost.png',
        'folder/note',
        new Set(['folder/cat.png']),
        undefined,
      ),
    ).toBe('missing');
  });

  test('undefined inventory partitions classify a resolvable src as missing', () => {
    // Both partitions absent (cold/legacy snapshot) — a resolvable project path
    // with no inventory to confirm it is treated as missing by this pure
    // function; the hook layer suppresses this during the cold load.
    expect(classifyImageTargetExistence('/images/cat.png', '', undefined, undefined)).toBe(
      'missing',
    );
  });
});
