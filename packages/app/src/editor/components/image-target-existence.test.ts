import { createTargetNamespace } from '@inkeep/open-knowledge-core';
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

  test('existence matches by NFC and file-name case while parent folder case stays significant', () => {
    const assets = createTargetNamespace('file', ['images/cat.png', 'images/Cafe\u0301.png']);
    expect(classifyImageTargetExistence('/images/Cat.PNG', '', assets, undefined)).toBe('exists');
    expect(classifyImageTargetExistence('/Images/cat.png', '', assets, undefined)).toBe('missing');
    expect(classifyImageTargetExistence('/images/Caf\u00e9.png', '', assets, undefined)).toBe(
      'exists',
    );
    expect(
      classifyImageTargetExistence(
        '/images/Cafe\u0301.png',
        '',
        createTargetNamespace('file', ['images/Caf\u00e9.png']),
        undefined,
      ),
    ).toBe('exists');
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
    expect(classifyImageTargetExistence('../../../etc/passwd.png', '', new Set(), new Set())).toBe(
      'unknown',
    );
  });

  test('a doc-relative src resolves against the source doc directory', () => {
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
    expect(classifyImageTargetExistence('/images/cat.png', '', undefined, undefined)).toBe(
      'missing',
    );
  });
});
