import { describe, expect, test } from 'vitest';
import {
  createEmptyActiveTarget,
  docNameFromActiveTarget,
  EditorActiveTargetRegistry,
} from './active-target-registry.ts';

const WIN_A = 1;
const WIN_B = 2;

function doc(identifier: string) {
  return { kind: 'doc' as const, identifier };
}

describe('EditorActiveTargetRegistry', () => {
  test('an unknown window reads as no target', () => {
    const registry = new EditorActiveTargetRegistry();
    expect(registry.get(WIN_A)).toEqual(createEmptyActiveTarget());
  });

  test('two windows retain their own targets with no cross-clobber', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.update(WIN_B, doc('notes/beta'));

    expect(registry.get(WIN_A)).toEqual(doc('notes/alpha'));
    expect(registry.get(WIN_B)).toEqual(doc('notes/beta'));
  });

  test('current() follows the focused window, not the last pusher', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.update(WIN_B, doc('notes/beta'));

    expect(registry.current(WIN_A)).toEqual(doc('notes/alpha'));
    expect(registry.current(WIN_B)).toEqual(doc('notes/beta'));
  });

  test('current() falls back to the most recent pusher when nothing is focused', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.update(WIN_B, doc('notes/beta'));

    expect(registry.current(null)).toEqual(doc('notes/beta'));
  });

  test('an empty registry reads as no target even unfocused', () => {
    expect(new EditorActiveTargetRegistry().current(null)).toEqual(createEmptyActiveTarget());
  });

  test('a later push replaces that window own target only', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.update(WIN_B, doc('notes/beta'));
    registry.update(WIN_A, doc('notes/gamma'));

    expect(registry.get(WIN_A)).toEqual(doc('notes/gamma'));
    expect(registry.get(WIN_B)).toEqual(doc('notes/beta'));
  });

  test('deleting a window drops its target and its fallback claim', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.delete(WIN_A);

    expect(registry.get(WIN_A)).toEqual(createEmptyActiveTarget());
    expect(registry.current(null)).toEqual(createEmptyActiveTarget());
  });

  test('deleting one window leaves another window fallback intact', () => {
    const registry = new EditorActiveTargetRegistry();
    registry.update(WIN_A, doc('notes/alpha'));
    registry.update(WIN_B, doc('notes/beta'));
    registry.delete(WIN_A);

    expect(registry.current(null)).toEqual(doc('notes/beta'));
  });
});

describe('docNameFromActiveTarget', () => {
  test('reads the document out of a doc target', () => {
    expect(docNameFromActiveTarget(doc('notes/alpha'))).toBe('notes/alpha');
  });

  test('is null for a non-doc target', () => {
    expect(docNameFromActiveTarget({ kind: 'folder', identifier: 'notes' })).toBeNull();
    expect(docNameFromActiveTarget(createEmptyActiveTarget())).toBeNull();
  });

  test('is null for an empty identifier, which names no document', () => {
    expect(docNameFromActiveTarget(doc(''))).toBeNull();
  });
});
