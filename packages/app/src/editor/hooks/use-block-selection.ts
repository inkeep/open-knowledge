
import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { type BlockSelection, getBlockSelection } from '../extensions/selection-state-plugin.ts';

export function useBlockSelection(editor: Editor | null): BlockSelection | null {
  const [snapshot, setSnapshot] = useState<BlockSelection | null>(() =>
    editor ? getBlockSelection(editor) : null,
  );

  useEffect(() => {
    if (!editor) {
      setSnapshot(null);
      return;
    }

    setSnapshot(getBlockSelection(editor));

    const update = () => {
      setSnapshot(getBlockSelection(editor));
    };

    editor.on('transaction', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('transaction', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  return snapshot;
}
