import { t } from '@lingui/core/macro';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { useEffect, useRef } from 'react';
import { blockMoveAnnouncementKey } from '../../editor/extensions/block-mover';
import { getBridgeId } from '../../editor/extensions/bridge-id-plugin.ts';
import {
  type BlockSelection,
  getBlockSelection,
} from '../../editor/extensions/selection-state-plugin';
import { getEntryLabel } from '../../editor/selection/entry-label.ts';

const ANNOUNCE_DEBOUNCE_MS = 200;

type SelectionContext = {
  chain: { id: string | undefined; pos: number; yElement: object | undefined }[];
  message: string;
};

export function SelectionAnnouncer({ editor }: { editor: Editor | null }) {
  const regionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editor) return;
    let timeout: number | null = null;
    let movePending = false;
    let lastWasSelected = false;
    let lastContext: SelectionContext | null = null;
    const update = (transaction?: Transaction) => {
      const meta: unknown = transaction?.getMeta(blockMoveAnnouncementKey);
      const direction = meta === 'up' || meta === 'down' ? meta : undefined;
      const moved = transaction?.docChanged ? direction : undefined;
      const region = regionRef.current;
      if (!region) return;
      if (!moved && movePending) return;
      const blockSelection = getBlockSelection(editor);
      const sync: { binding?: { mapping: Map<object, unknown> } } | undefined =
        ySyncPluginKey.getState(editor.state);
      const previous = lastContext;
      const chain = blockSelection.ancestorChain.map(({ pos }, index) => {
        const node = editor.state.doc.nodeAt(pos);
        const prior = previous?.chain[index]?.yElement;
        return {
          id: getBridgeId(editor.state, pos),
          pos,
          yElement: prior && sync?.binding?.mapping.get(prior) === node ? prior : undefined,
        };
      });
      const unresolved = new Map<unknown, (typeof chain)[number]>(
        chain
          .filter((entry) => !entry.yElement)
          .map((entry) => [editor.state.doc.nodeAt(entry.pos), entry]),
      );
      if (unresolved.size && sync?.binding) {
        for (const [element, node] of sync.binding.mapping) {
          const entry = unresolved.get(node);
          if (!entry) continue;
          entry.yElement = element;
          unresolved.delete(node);
          if (!unresolved.size) break;
        }
      }
      const context: SelectionContext = {
        chain,
        message: formatSelectionMessage(editor, blockSelection),
      };
      const unchanged =
        previous !== null &&
        context.message === previous.message &&
        context.chain.length === previous.chain.length &&
        context.chain.every((entry, index) => {
          const prior = previous.chain[index];
          if (entry.yElement && prior.yElement) return entry.yElement === prior.yElement;
          if (entry.id && entry.id === prior.id) return true;
          const mapped = transaction?.mapping.mapResult(prior.pos, 1);
          return !mapped?.deleted && entry.pos === (mapped?.pos ?? prior.pos);
        });
      lastContext = context;
      if (!moved && unchanged) return;
      if (timeout !== null) window.clearTimeout(timeout);
      const isSelected = context.chain.length > 0;
      let message: string;
      if (moved) {
        movePending = true;
        message = moved === 'up' ? t`Moved up.` : t`Moved down.`;
      } else if (isSelected) {
        message = context.message;
      } else {
        message = lastWasSelected ? t`Outside any block` : '';
      }
      region.textContent = '';
      timeout = window.setTimeout(() => {
        region.textContent = message;
        lastWasSelected = isSelected;
        movePending = false;
        timeout = null;
      }, ANNOUNCE_DEBOUNCE_MS);
    };
    const onTransaction = ({ transaction }: { transaction: Transaction }) => update(transaction);
    editor.on('transaction', onTransaction);
    update();
    return () => {
      editor.off('transaction', onTransaction);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [editor]);

  return (
    <div ref={regionRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
  );
}

export function formatSelectionMessage(
  editor: Editor,
  blockSelection: BlockSelection | null,
): string {
  if (!blockSelection || blockSelection.ancestorChain.length === 0) {
    return '';
  }

  const chain = blockSelection.ancestorChain;
  const innermost = chain[chain.length - 1];
  const innermostLabel = getEntryLabel(innermost, { unregisteredSuffix: true });

  if (chain.length === 1) {
    return t`Selected: ${innermostLabel}`;
  }

  const parent = chain[chain.length - 2];
  const parentLabel = getEntryLabel(parent);

  try {
    const $pos = editor.state.doc.resolve(innermost.pos);
    const position = $pos.index($pos.depth) + 1;
    const total = $pos.parent.childCount;
    return t`Selected: ${innermostLabel}, ${position} of ${total} in ${parentLabel}`;
  } catch {
    return t`Selected: ${innermostLabel} in ${parentLabel}`;
  }
}
