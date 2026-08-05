import { Annotation, Transaction as CMTransaction, EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  isUserIntentCmUpdate,
  isUserIntentPmTransaction,
  requestPreviewTabPromotion,
  subscribePreviewTabPromotion,
} from './preview-tab-promotion';

let unsubscribePromotion: (() => void) | undefined;

/**
 * Minimal PM-transaction stand-in. The predicate reads exactly two properties,
 * and a real ProseMirror transaction needs a schema + doc that add nothing to
 * what is under test.
 */
function pmTransaction(docChanged: boolean, syncMeta?: unknown) {
  return {
    docChanged,
    getMeta: (key: unknown) => (key === ySyncPluginKey ? syncMeta : undefined),
  } as unknown as Parameters<typeof isUserIntentPmTransaction>[0];
}

/** A ViewUpdate stand-in carrying just the fields the predicate reads. */
function cmUpdate(docChanged: boolean, userEvents: (string | undefined)[]): ViewUpdate {
  return {
    docChanged,
    transactions: userEvents.map((userEvent) => ({
      annotation: (type: unknown) => (type === CMTransaction.userEvent ? userEvent : undefined),
    })),
  } as unknown as ViewUpdate;
}

afterEach(() => {
  unsubscribePromotion?.();
});

describe('isUserIntentPmTransaction', () => {
  test('a local content change with no sync meta is a user edit', () => {
    expect(isUserIntentPmTransaction(pmTransaction(true))).toBe(true);
  });

  test('a CRDT-origin change is not — this is what keeps agent writes from promoting', () => {
    expect(isUserIntentPmTransaction(pmTransaction(true, { isChangeOrigin: true }))).toBe(false);
  });

  test('selection-only transactions are not edits', () => {
    // Arrow keys and clicks produce these constantly; promoting on them would
    // make every previewed doc permanent the moment it took focus.
    expect(isUserIntentPmTransaction(pmTransaction(false))).toBe(false);
  });

  test('any present sync meta counts as sync, whatever its shape', () => {
    // The guard tests for the meta's presence, not for `isChangeOrigin`. That
    // is deliberate: it fails closed, so a y-prosemirror change to the meta
    // payload costs a missed promotion rather than a tab promoted by an agent.
    expect(isUserIntentPmTransaction(pmTransaction(true, {}))).toBe(false);
    expect(isUserIntentPmTransaction(pmTransaction(true, { isChangeOrigin: false }))).toBe(false);
  });
});

describe('isUserIntentCmUpdate', () => {
  test('a typed character is a user edit', () => {
    expect(isUserIntentCmUpdate(cmUpdate(true, ['input.type']))).toBe(true);
  });

  test('paste and delete are user edits', () => {
    expect(isUserIntentCmUpdate(cmUpdate(true, ['input.paste']))).toBe(true);
    expect(isUserIntentCmUpdate(cmUpdate(true, ['delete.backward']))).toBe(true);
  });

  test('a y-codemirror sync dispatch carries no userEvent, so it is not', () => {
    expect(isUserIntentCmUpdate(cmUpdate(true, [undefined]))).toBe(false);
  });

  test('selection-only updates are not edits', () => {
    expect(isUserIntentCmUpdate(cmUpdate(false, ['select.pointer']))).toBe(false);
  });

  test('a mixed update promotes when any transaction is user-driven', () => {
    expect(isUserIntentCmUpdate(cmUpdate(true, [undefined, 'input.type']))).toBe(true);
  });
});

describe('isUserIntentCmUpdate against real CodeMirror transactions', () => {
  // Pins the predicate to CodeMirror's actual annotation plumbing rather than
  // the hand-rolled stand-in above, so an upstream change to how userEvent is
  // carried fails here instead of silently disabling promotion.
  const state = EditorState.create({ doc: 'hello' });

  test('a userEvent-annotated change is detected', () => {
    const transaction = state.update({
      changes: { from: 5, insert: '!' },
      userEvent: 'input.type',
    });
    expect(isUserIntentCmUpdate(cmUpdateFrom(transaction))).toBe(true);
  });

  test('a programmatic change with a foreign annotation is not', () => {
    const foreign = Annotation.define<string>();
    const transaction = state.update({
      changes: { from: 5, insert: '!' },
      annotations: foreign.of('sync'),
    });
    expect(isUserIntentCmUpdate(cmUpdateFrom(transaction))).toBe(false);
  });

  function cmUpdateFrom(transaction: ReturnType<typeof state.update>): ViewUpdate {
    return {
      docChanged: transaction.docChanged,
      transactions: [transaction],
    } as unknown as ViewUpdate;
  }
});

describe('the user-edit listener', () => {
  test('notifications reach the registered listener', () => {
    const listener = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(listener);
    requestPreviewTabPromotion('docs/notes');
    expect(listener).toHaveBeenCalledWith('docs/notes');
  });

  test('unregistering stops delivery', () => {
    const listener = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(listener);
    unsubscribePromotion?.();
    requestPreviewTabPromotion('docs/notes');
    expect(listener).not.toHaveBeenCalled();
  });

  test('an empty docName is dropped rather than forwarded', () => {
    // A provider mid-teardown reports an empty name; forwarding it would make
    // the consumer resolve a tab id of "".
    const listener = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(listener);
    requestPreviewTabPromotion('');
    expect(listener).not.toHaveBeenCalled();
  });

  test('notifying with no listener registered is a no-op', () => {
    expect(() => requestPreviewTabPromotion('docs/notes')).not.toThrow();
  });
});
