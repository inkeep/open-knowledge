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
