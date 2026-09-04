import { bindFrontmatterDoc, type FrontmatterBinding } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  MUTATING_BINDING_METHODS,
  READ_ONLY_BINDING_METHODS,
  subscribePreviewTabPromotion,
  withPreviewTabPromotion,
} from './preview-tab-promotion';

let unsubscribePromotion: (() => void) | undefined;

function makeBinding(seed: string): FrontmatterBinding {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  doc.transact(() => ytext.insert(0, seed));
  return bindFrontmatterDoc({ document: doc, on: () => {}, off: () => {} } as never);
}

afterEach(() => {
  unsubscribePromotion?.();
});

describe('withPreviewTabPromotion — coverage', () => {
  test('every method on the binding is either wrapped as mutating or listed read-only', () => {
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const methods = Object.entries(binding)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => key)
      .sort();

    const accounted = [...MUTATING_BINDING_METHODS, ...READ_ONLY_BINDING_METHODS].sort();

    expect(methods).toEqual(accounted);
    binding.dispose();
  });

  test('the wrapper exposes every method the raw binding does', () => {
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'doc');

    for (const key of Object.keys(binding)) {
      expect(wrapped).toHaveProperty(key);
    }
    binding.dispose();
  });
});

describe('withPreviewTabPromotion — announcement', () => {
  test('a successful mutation announces exactly once', () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'notes/thing');

    const result = wrapped.patch({ title: 'Published' });

    expect(result.ok).toBe(true);
    expect(onUserEdit).toHaveBeenCalledExactlyOnceWith('notes/thing');
    binding.dispose();
  });

  test('a nested path edit announces — this is the route that bypassed the panel', () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);
    const binding = makeBinding('---\nmetadata:\n  version: "1.0.0"\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'notes/thing');

    const result = wrapped.patchPath(['metadata', 'version'], '2.0.0');

    expect(result.ok).toBe(true);
    expect(onUserEdit).toHaveBeenCalledWith('notes/thing');
    binding.dispose();
  });

  test('a rejected mutation announces nothing', () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'notes/thing');

    const result = wrapped.patch({ frontmatter: 'nope' });

    expect(result.ok).toBe(false);
    expect(onUserEdit).not.toHaveBeenCalled();
    binding.dispose();
  });

  test('reads announce nothing', () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'notes/thing');

    wrapped.current();
    const unsub = wrapped.subscribe(() => {});
    unsub();

    expect(onUserEdit).not.toHaveBeenCalled();
    binding.dispose();
  });

  test('the wrapped binding still returns the raw result to its caller', () => {
    const binding = makeBinding('---\ntitle: Draft\n---\n');
    const wrapped = withPreviewTabPromotion(binding, 'notes/thing');

    const result = wrapped.patch({ title: 'Published' });

    expect(result).toMatchObject({ ok: true, appliedKeys: ['title'] });
    expect(wrapped.current().map.title).toBe('Published');
    binding.dispose();
  });
});
