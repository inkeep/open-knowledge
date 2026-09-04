import { afterEach, describe, expect, test } from 'vitest';
import { seedInitialDocHash, seedInitialDocHashFromWindow } from './single-file-initial-doc';

describe('seedInitialDocHash', () => {
  function harness(initialDoc: string | null | undefined, startHash: string) {
    let hash = startHash;
    const sets: string[] = [];
    seedInitialDocHash({
      initialDoc,
      getHash: () => hash,
      setHash: (h) => {
        hash = h;
        sets.push(h);
      },
    });
    return { hash, sets };
  }

  test('seeds #/<doc> when the hash is empty', () => {
    const { hash, sets } = harness('todo', '');
    expect(hash).toBe('#/todo');
    expect(sets).toEqual(['#/todo']);
  });

  test('seeds over the bare `#` and content-root `#/` base states', () => {
    expect(harness('todo', '#').hash).toBe('#/todo');
    expect(harness('todo', '#/').hash).toBe('#/todo');
  });

  test('percent-encodes a docName with a space', () => {
    expect(harness('My Notes', '').hash).toBe('#/My%20Notes');
  });

  test('percent-encodes a docName containing a route metacharacter', () => {
    expect(harness('# 2 - Tokens', '').hash).toBe('#/%23%202%20-%20Tokens');
  });

  test('no-op when initialDoc is null (every non-ephemeral window)', () => {
    expect(harness(null, '').sets).toEqual([]);
  });

  test('no-op when initialDoc is undefined (absent bridge field)', () => {
    expect(harness(undefined, '').sets).toEqual([]);
  });

  test('does not clobber a hash that already carries a doc target', () => {
    const { hash, sets } = harness('todo', '#/other-doc');
    expect(hash).toBe('#/other-doc');
    expect(sets).toEqual([]);
  });

  test('does not clobber an asset or dialog hash', () => {
    expect(harness('todo', '#/__asset__/img.png').sets).toEqual([]);
    expect(harness('todo', '#settings').sets).toEqual([]);
  });
});

describe('seedInitialDocHashFromWindow', () => {
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  function seedWith(okDesktop: unknown, startHash = ''): string {
    const location = { hash: startHash };
    (globalThis as { window?: unknown }).window = { okDesktop, location };
    seedInitialDocHashFromWindow();
    return location.hash;
  }

  test('seeds the live hash from an ephemeral bridge config', () => {
    expect(seedWith({ config: { initialDoc: 'todo' } })).toBe('#/todo');
  });

  test('no-op when the bridge reports no initialDoc (a normal project window)', () => {
    expect(seedWith({ config: { initialDoc: null } })).toBe('');
  });

  test('no-op when there is no desktop bridge (web/CLI)', () => {
    expect(seedWith(undefined)).toBe('');
  });
});
