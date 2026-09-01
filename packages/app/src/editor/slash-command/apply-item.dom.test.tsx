/**
 * Error-path pins for `applySlashCommandItem` (precedent #58 boundary).
 *
 * The happy-path single-transaction semantics are pinned in
 * `../extensions/slash-command-atomicity.dom.test.tsx`; this file pins the
 * three deliberate failure-mode behaviors of the boundary:
 *
 *   1. An item whose `command` throws must NOT roll back the trigger-range
 *      delete — the chain's `.command()` step returns true unconditionally so
 *      the user's `/query` text does not survive a broken item. The failure
 *      is surfaced via `console.error` after the dispatch.
 *   2. A throwing `afterCommit` callback must not starve the remaining
 *      deferred callbacks, and its log message must be distinguishable from
 *      an item-command failure (the two share a catch-shaped code path but
 *      mean different things when debugging).
 *   3. A throwing item must not poison the dispatch: the delete still lands
 *      as a doc-changing transaction and the editor stays usable.
 *
 * Tier: `.dom.test.tsx` (jsdom) — `applySlashCommandItem` drives a real
 * `editor.chain()`, so it needs a mounted TipTap Editor.
 */

import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Zap } from 'lucide-react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sharedExtensions } from '../extensions/shared';
import { applySlashCommandItem } from './apply-item';
import type { SlashCommandItem } from './items';

function mountEditor(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
}

function makeItem(overrides: Partial<SlashCommandItem>): SlashCommandItem {
  return {
    name: 'test-item',
    label: 'Test item',
    icon: Zap,
    category: 'basic',
    command: () => {},
    ...overrides,
  };
}

function typeTrigger(editor: Editor, text: string): { from: number; to: number } {
  editor.commands.focus('end');
  const from = editor.state.selection.from;
  editor.commands.insertContent(text);
  return { from, to: editor.state.selection.from };
}

describe('applySlashCommandItem error paths', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('a throwing item command does not roll back the trigger-range delete', () => {
    const { editor, container } = mountEditor();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const range = typeTrigger(editor, 'xboom');
      const itemFailure = new Error('item exploded');
      const item = makeItem({
        name: 'boom',
        command: () => {
          throw itemFailure;
        },
      });

      let docChangingCount = 0;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) docChangingCount += 1;
      });

      applySlashCommandItem({ editor, item, range });

      expect(editor.state.doc.textContent).not.toContain('xboom');
      expect(docChangingCount).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[slash-command] command "boom" threw an error',
        itemFailure,
      );
      expect(editor.commands.insertContent('still alive')).toBe(true);
      expect(editor.state.doc.textContent).toContain('still alive');
    } finally {
      teardown(editor, container);
    }
  });

  test('a throwing afterCommit callback does not starve later callbacks and logs distinguishably', () => {
    const { editor, container } = mountEditor();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const range = typeTrigger(editor, 'xdefer');
      const deferredFailure = new Error('deferred exploded');
      const secondCallback = vi.fn();
      const item = makeItem({
        name: 'defer',
        command: ({ chain, afterCommit }) => {
          chain().insertContent('inserted').run();
          afterCommit(() => {
            throw deferredFailure;
          });
          afterCommit(secondCallback);
        },
      });

      applySlashCommandItem({ editor, item, range });

      expect(editor.state.doc.textContent).toContain('inserted');
      expect(editor.state.doc.textContent).not.toContain('xdefer');
      expect(secondCallback).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[slash-command] afterCommit callback for "defer" threw an error',
        deferredFailure,
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        '[slash-command] command "defer" threw an error',
        deferredFailure,
      );
    } finally {
      teardown(editor, container);
    }
  });

  test('a dispatch failure surfaces a preceding item failure instead of swallowing it', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatchFailure = new Error('dispatch exploded');
    const itemFailure = new Error('item exploded');
    type CommandFn = (props: { chain: unknown; state: unknown }) => boolean;
    let commandFn: CommandFn | null = null;
    const chainDouble = {
      focus: () => chainDouble,
      deleteRange: () => chainDouble,
      command: (fn: CommandFn) => {
        commandFn = fn;
        return chainDouble;
      },
      run: () => {
        commandFn?.({ chain: undefined, state: undefined });
        throw dispatchFailure;
      },
    };
    const editorDouble = { chain: () => chainDouble } as unknown as Editor;
    const item = makeItem({
      name: 'dual',
      command: () => {
        throw itemFailure;
      },
    });

    applySlashCommandItem({ editor: editorDouble, item, range: { from: 0, to: 1 } });

    expect(consoleError).toHaveBeenCalledWith(
      '[slash-command] deleteRange failed for "dual"',
      dispatchFailure,
    );
    expect(consoleError).toHaveBeenCalledWith(
      '[slash-command] command "dual" threw an error',
      itemFailure,
    );
  });

  test('a throwing item still commits the delete in the same single transaction as a working item would', () => {
    const { editor, container } = mountEditor();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const range = typeTrigger(editor, 'xpartial');
      const item = makeItem({
        name: 'partial',
        command: ({ chain }) => {
          chain().insertContent('kept').run();
          throw new Error('after contributing steps');
        },
      });

      let docChangingCount = 0;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) docChangingCount += 1;
      });

      applySlashCommandItem({ editor, item, range });

      expect(docChangingCount).toBe(1);
      expect(editor.state.doc.textContent).toContain('kept');
      expect(editor.state.doc.textContent).not.toContain('xpartial');
    } finally {
      teardown(editor, container);
    }
  });
});
