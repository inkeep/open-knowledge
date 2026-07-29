import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import type { BlockAnchor } from './mode-switch-position-resolver';
import {
  clearPendingNavigationForExitedMode,
  clearPendingSourceNavigation,
  clearPendingSourceNavigationsForTest,
  clearPendingWysiwygNavigation,
  clearPendingWysiwygNavigationsForTest,
  consumePendingSourceNavigation,
  consumePendingWysiwygNavigation,
  createNavigationPin,
  peekPendingSourceNavigation,
  peekPendingWysiwygNavigation,
  rememberPendingSourceNavigation,
  rememberPendingWysiwygNavigation,
  resolveNavigationPin,
} from './source-editor-navigation';

afterEach(() => {
  clearPendingSourceNavigationsForTest();
  clearPendingWysiwygNavigationsForTest();
  vi.useRealTimers();
});

describe('source-editor-navigation', () => {
  test('consume returns the pending navigation once for a doc', () => {
    const navigation = {
      kind: 'raw-mdx' as const,
      detail: { offset: 42 },
    };

    rememberPendingSourceNavigation('doc-a', navigation);

    expect(peekPendingSourceNavigation('doc-a')).toEqual(navigation);
    expect(consumePendingSourceNavigation('doc-a')).toEqual(navigation);
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('pending navigation is doc-scoped and latest-write-wins per doc', () => {
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 7 },
    });
    rememberPendingSourceNavigation('doc-a', {
      kind: 'outline',
      detail: { index: 3, slug: 'intro', mode: 'source' },
    });
    rememberPendingSourceNavigation('doc-b', {
      kind: 'raw-mdx',
      detail: { offset: 99 },
    });

    expect(consumePendingSourceNavigation('doc-a')).toEqual({
      kind: 'outline',
      detail: { index: 3, slug: 'intro', mode: 'source' },
    });
    expect(consumePendingSourceNavigation('doc-b')).toEqual({
      kind: 'raw-mdx',
      detail: { offset: 99 },
    });
  });

  test('clearPendingSourceNavigation removes entry without returning it', () => {
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 1 },
    });
    clearPendingSourceNavigation('doc-a');
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('the source store carries a selection-offset intent alongside the panel kinds', () => {
    const anchor: BlockAnchor = { blockIndex: 2, kind: 'paragraph', content: 'target' };
    rememberPendingSourceNavigation('doc-a', { kind: 'selection-offset', anchor });

    expect(peekPendingSourceNavigation('doc-a')).toEqual({ kind: 'selection-offset', anchor });
    expect(consumePendingSourceNavigation('doc-a')).toEqual({ kind: 'selection-offset', anchor });
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });
});

describe('pending-intent expiry', () => {
  const lintNavigation = {
    kind: 'lint' as const,
    detail: { line: 7, column: 2 },
  };

  test('an intent older than 30 seconds is discarded at consume time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    vi.setSystemTime(new Date('2026-07-09T12:00:30.001Z'));
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('an intent aged exactly 30 seconds is still consumed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    vi.setSystemTime(new Date('2026-07-09T12:00:30.000Z'));
    expect(consumePendingSourceNavigation('doc-a')).toEqual(lintNavigation);
  });

  test('peek reports an expired intent as absent', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    vi.setSystemTime(new Date('2026-07-09T12:01:00.000Z'));
    expect(peekPendingSourceNavigation('doc-a')).toBeNull();
  });

  test('re-remembering restarts the expiry clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 7 },
    });

    vi.setSystemTime(new Date('2026-07-09T12:00:20.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    // 40s after the first remember, 20s after the second — the refreshed
    // timestamp keeps the intent alive.
    vi.setSystemTime(new Date('2026-07-09T12:00:40.000Z'));
    expect(consumePendingSourceNavigation('doc-a')).toEqual(lintNavigation);
  });
});

describe('wysiwyg pending-navigation store', () => {
  const anchor: BlockAnchor = { blockIndex: 1, kind: 'heading', content: 'Section' };

  test('consume returns the pending WYSIWYG navigation once for a doc', () => {
    rememberPendingWysiwygNavigation('doc-a', { kind: 'selection-offset', anchor });

    expect(peekPendingWysiwygNavigation('doc-a')).toEqual({ kind: 'selection-offset', anchor });
    expect(consumePendingWysiwygNavigation('doc-a')).toEqual({ kind: 'selection-offset', anchor });
    expect(consumePendingWysiwygNavigation('doc-a')).toBeNull();
  });

  test('WYSIWYG navigation is doc-scoped', () => {
    const a: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: 'a' };
    const b: BlockAnchor = { blockIndex: 4, kind: 'paragraph', content: 'b' };
    rememberPendingWysiwygNavigation('doc-a', { kind: 'selection-offset', anchor: a });
    rememberPendingWysiwygNavigation('doc-b', { kind: 'selection-offset', anchor: b });

    expect(consumePendingWysiwygNavigation('doc-a')?.anchor).toEqual(a);
    expect(consumePendingWysiwygNavigation('doc-b')?.anchor).toEqual(b);
  });

  test('clearPendingWysiwygNavigation removes entry without returning it', () => {
    rememberPendingWysiwygNavigation('doc-a', { kind: 'selection-offset', anchor });
    clearPendingWysiwygNavigation('doc-a');
    expect(consumePendingWysiwygNavigation('doc-a')).toBeNull();
  });

  test('a WYSIWYG intent older than 30 seconds is discarded at consume time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingWysiwygNavigation('doc-a', { kind: 'selection-offset', anchor });

    vi.setSystemTime(new Date('2026-07-09T12:00:30.001Z'));
    expect(consumePendingWysiwygNavigation('doc-a')).toBeNull();
  });
});

describe('mode-exit clearing', () => {
  const srcAnchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: 'source side' };
  const wysAnchor: BlockAnchor = { blockIndex: 0, kind: 'paragraph', content: 'wysiwyg side' };

  test('leaving source clears the source intent', () => {
    rememberPendingSourceNavigation('doc-a', { kind: 'selection-offset', anchor: srcAnchor });
    clearPendingNavigationForExitedMode('doc-a', 'source');
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('leaving wysiwyg clears the wysiwyg intent', () => {
    rememberPendingWysiwygNavigation('doc-a', { kind: 'selection-offset', anchor: wysAnchor });
    clearPendingNavigationForExitedMode('doc-a', 'wysiwyg');
    expect(consumePendingWysiwygNavigation('doc-a')).toBeNull();
  });

  test('leaving a mode preserves the intent queued for the mode being entered', () => {
    // A W->S flip queues a source landing while leaving the WYSIWYG view.
    // Clearing the exited (WYSIWYG) mode must not discard that queued landing,
    // otherwise the flip that just banked it would erase itself.
    rememberPendingSourceNavigation('doc-a', { kind: 'selection-offset', anchor: srcAnchor });
    clearPendingNavigationForExitedMode('doc-a', 'wysiwyg');
    expect(consumePendingSourceNavigation('doc-a')).toEqual({
      kind: 'selection-offset',
      anchor: srcAnchor,
    });
  });
});

describe('navigation pin', () => {
  // Offsets index the target word 'target' within a fixed source string.
  const SOURCE = 'hello world target here';
  const TARGET_START = SOURCE.indexOf('target');
  const TARGET_END = TARGET_START + 'target'.length;

  function seed(): { doc: Y.Doc; text: Y.Text } {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    text.insert(0, SOURCE);
    return { doc, text };
  }

  test('a pin survives a remote insert before the target and tracks the moved offset', () => {
    const { doc, text } = seed();
    const pin = createNavigationPin(text, TARGET_START, TARGET_END);

    text.insert(0, 'PREFIX ');

    expect(resolveNavigationPin(pin, doc)).toBe(TARGET_START + 'PREFIX '.length);
  });

  test('a pin is lost when its target range is deleted', () => {
    const { doc, text } = seed();
    const pin = createNavigationPin(text, TARGET_START, TARGET_END);

    text.delete(TARGET_START, 'target'.length);

    expect(resolveNavigationPin(pin, doc)).toBeNull();
  });

  test('a pin is lost when a remote peer deletes the target and syncs it back', () => {
    const { doc, text } = seed();
    const pin = createNavigationPin(text, TARGET_START, TARGET_END);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getText('source').delete(TARGET_START, 'target'.length);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));

    expect(resolveNavigationPin(pin, doc)).toBeNull();
  });

  test('a partially-deleted target resolves to the surviving fragment', () => {
    const { doc, text } = seed();
    const pin = createNavigationPin(text, TARGET_START, TARGET_END);

    // Delete 'rget', leaving 'ta' at the original start.
    text.delete(TARGET_START + 2, 4);

    expect(resolveNavigationPin(pin, doc)).toBe(TARGET_START);
  });

  test('a pin that cannot be mapped into the document resolves to null', () => {
    const { text } = seed();
    const pin = createNavigationPin(text, TARGET_START, TARGET_END);

    // A document that never saw this pin's structure cannot resolve it.
    const other = new Y.Doc();
    other.getText('source').insert(0, SOURCE);

    expect(resolveNavigationPin(pin, other)).toBeNull();
  });

  test('creating and resolving a pin performs no mutation and opens no transaction', () => {
    const { doc, text } = seed();
    let updates = 0;
    let transactions = 0;
    doc.on('update', () => {
      updates++;
    });
    doc.on('afterTransaction', () => {
      transactions++;
    });

    const pin = createNavigationPin(text, TARGET_START, TARGET_END);
    resolveNavigationPin(pin, doc);

    expect(updates).toBe(0);
    expect(transactions).toBe(0);
  });
});
