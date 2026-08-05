/**
 * DOM tests for `useBooleanFrontmatterField` — the boolean sibling of
 * `useFrontmatterField`. Covers strict-boolean identity, live updates as
 * frontmatter changes, and binding teardown on unmount.
 *
 * The fake provider wraps a real `Y.Doc` so every case runs through the real
 * `bindFrontmatterDoc` YAML parse: the string "true" and the number 1 are
 * produced by the real parser, not hand-forced JS values.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { bindFrontmatterDoc } from '@inkeep/open-knowledge-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { useBooleanFrontmatterField } from './use-boolean-frontmatter-field';

interface FakeProvider {
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
  /** How many 'synced' listeners are currently attached — used to prove the
   *  binding detaches on unmount. */
  syncedListenerCount(): number;
}

function makeProvider(initial = ''): FakeProvider {
  const document = new Y.Doc();
  if (initial) document.getText('source').insert(0, initial);
  const handlers = new Set<() => void>();
  return {
    document,
    on(event, listener) {
      if (event === 'synced') handlers.add(listener);
    },
    off(event, listener) {
      if (event === 'synced') handlers.delete(listener);
    },
    syncedListenerCount() {
      return handlers.size;
    },
  };
}

function renderFlag(provider: FakeProvider, key = 'slides') {
  return renderHook(() =>
    useBooleanFrontmatterField(provider as unknown as HocuspocusProvider, key),
  );
}

/** Mutate the shared frontmatter region the way a property-panel edit would —
 *  a second binding on the same doc, so the hook's own observer fires. */
function patchSlides(provider: FakeProvider, value: boolean | string | null): void {
  const writer = bindFrontmatterDoc(provider);
  writer.patch({ slides: value });
  writer.dispose();
}

afterEach(() => {
  cleanup();
});

describe('useBooleanFrontmatterField — strict boolean identity', () => {
  test('the YAML boolean true reports true', () => {
    const { result } = renderFlag(makeProvider('---\nslides: true\n---\nbody\n'));
    expect(result.current).toBe(true);
  });

  test('the string "true" reports false', () => {
    const { result } = renderFlag(makeProvider('---\nslides: "true"\n---\nbody\n'));
    expect(result.current).toBe(false);
  });

  test('the number 1 reports false', () => {
    const { result } = renderFlag(makeProvider('---\nslides: 1\n---\nbody\n'));
    expect(result.current).toBe(false);
  });

  test('an absent key reports false', () => {
    const { result } = renderFlag(makeProvider('---\ntitle: Notes\n---\nbody\n'));
    expect(result.current).toBe(false);
  });

  test('a document with no frontmatter reports false', () => {
    const { result } = renderFlag(makeProvider('just body text\n'));
    expect(result.current).toBe(false);
  });
});

describe('useBooleanFrontmatterField — live updates', () => {
  test('adding slides: true flips the flag without remount', () => {
    const provider = makeProvider('---\ntitle: Notes\n---\nbody\n');
    const { result } = renderFlag(provider);
    expect(result.current).toBe(false);

    act(() => patchSlides(provider, true));

    expect(result.current).toBe(true);
  });

  test('removing the slides key clears the flag without remount', () => {
    const provider = makeProvider('---\nslides: true\n---\nbody\n');
    const { result } = renderFlag(provider);
    expect(result.current).toBe(true);

    act(() => patchSlides(provider, null));

    expect(result.current).toBe(false);
  });
});

describe('useBooleanFrontmatterField — teardown', () => {
  test('unmount disposes the binding so no observer remains', () => {
    const provider = makeProvider('---\nslides: true\n---\nbody\n');
    const { result, unmount } = renderFlag(provider);
    expect(result.current).toBe(true);
    // While mounted the binding holds one 'synced' listener on the provider (it
    // also holds one Y.Text observer; dispose() removes both together, so the
    // provider count returning to zero proves the whole binding was torn down).
    expect(provider.syncedListenerCount()).toBe(1);

    unmount();

    expect(provider.syncedListenerCount()).toBe(0);
  });

  test('a frontmatter edit after unmount does not resurface a stale value', () => {
    const provider = makeProvider('---\nslides: true\n---\nbody\n');
    const { result, unmount } = renderFlag(provider);
    unmount();

    act(() => patchSlides(provider, false));

    expect(result.current).toBe(true);
  });
});
