import { Annotation, Transaction as CMTransaction, EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { getSchema } from '@tiptap/core';
import { EditorState as PMEditorState } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { markAutonomousFragmentEdit } from './extensions/autonomous-fragment-edit';
import { sharedExtensions } from './extensions/shared';
import {
  isUserIntentCmUpdate,
  isUserIntentPmTransaction,
  requestPreviewTabPromotion,
  subscribePreviewTabPromotion,
} from './preview-tab-promotion';

let unsubscribePromotion: (() => void) | undefined;

function pmTransaction(docChanged: boolean, syncMeta?: unknown) {
  return {
    docChanged,
    getMeta: (key: unknown) => (key === ySyncPluginKey ? syncMeta : undefined),
  } as unknown as Parameters<typeof isUserIntentPmTransaction>[0];
}

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
    expect(isUserIntentPmTransaction(pmTransaction(false))).toBe(false);
  });

  test('a NodeView representation swap is not a user edit', () => {
    const schema = getSchema(sharedExtensions);
    const state = PMEditorState.create({
      doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('body')])]),
    });
    const swap = markAutonomousFragmentEdit(state.tr.insertText('x', 1));

    expect(swap.docChanged).toBe(true);
    expect(isUserIntentPmTransaction(swap)).toBe(false);
    expect(isUserIntentPmTransaction(state.tr.insertText('x', 1))).toBe(true);
  });

  test('any present sync meta counts as sync, whatever its shape', () => {
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
    const listener = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(listener);
    requestPreviewTabPromotion('');
    expect(listener).not.toHaveBeenCalled();
  });

  test('notifying with no listener registered is a no-op', () => {
    expect(() => requestPreviewTabPromotion('docs/notes')).not.toThrow();
  });
});
