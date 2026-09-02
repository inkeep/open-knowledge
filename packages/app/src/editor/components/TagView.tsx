import { INLINE_TAG_VALUE_RE } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { NodeViewWrapper } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

function commitDraft(
  editor: NodeViewProps['editor'],
  pos: number | undefined,
  next: string,
): boolean {
  if (typeof pos !== 'number') return false;
  if (!next || !INLINE_TAG_VALUE_RE.test(next)) return false;
  const { state, view } = editor;
  const curNode = state.doc.nodeAt(pos);
  if (!curNode || curNode.type.name !== 'tag') return false;
  const tr = state.tr.setNodeMarkup(pos, null, { ...curNode.attrs, value: next });
  const after = pos + curNode.nodeSize;
  tr.insertText(' ', after);
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr);
  view.focus();
  return true;
}

function cancelDraft(editor: NodeViewProps['editor'], pos: number | undefined): void {
  if (typeof pos !== 'number') return;
  const { state, view } = editor;
  const curNode = state.doc.nodeAt(pos);
  if (!curNode || curNode.type.name !== 'tag') return;
  const tr = state.tr.delete(pos, pos + curNode.nodeSize);
  view.dispatch(tr);
  view.focus();
}

interface RenderedTagChipProps {
  value: string;
}

function RenderedTagChip({ value }: RenderedTagChipProps) {
  return (
    <a className="tag" data-tag={value} href={`#tag/${value}`}>
      #{value}
    </a>
  );
}

interface PlaceholderInputProps {
  initialDraft: string;
  onCommit: (next: string) => boolean;
  onCancel: () => void;
}

function PlaceholderInput({ initialDraft, onCommit, onCancel }: PlaceholderInputProps) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const committedRef = useRef(false);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  return (
    <span
      className="tag tag-placeholder inline-flex items-center rounded-sm border border-dashed border-muted-foreground/40 bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground"
      data-component-type="tag-placeholder"
    >
      <span aria-hidden="true" className="font-mono">
        #
      </span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        size={Math.max(draft.length, 8)}
        placeholder={t`tag-name`}
        aria-label={t`Tag value`}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="bg-transparent border-0 p-0 outline-none focus:outline-none focus:ring-0 text-inherit font-inherit"
        onChange={(e) => {
          const next = e.target.value;
          if (next === '' || INLINE_TAG_VALUE_RE.test(next)) {
            setDraft(next);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            committedRef.current = true;
            const ok = onCommit(draft);
            if (!ok) {
              committedRef.current = false;
              onCancel();
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Backspace' && draft === '') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (committedRef.current) return;
          if (draft === '') {
            onCancel();
            return;
          }
          if (INLINE_TAG_VALUE_RE.test(draft)) {
            onCommit(draft);
          } else {
            onCancel();
          }
        }}
      />
    </span>
  );
}

export function TagView({ node, getPos, editor }: NodeViewProps) {
  const value = typeof node.attrs.value === 'string' ? node.attrs.value : '';

  if (value === '') {
    return (
      <NodeViewWrapper as="span">
        <PlaceholderInput
          initialDraft=""
          onCommit={(next) =>
            commitDraft(editor, typeof getPos === 'function' ? getPos() : undefined, next)
          }
          onCancel={() => cancelDraft(editor, typeof getPos === 'function' ? getPos() : undefined)}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span">
      <RenderedTagChip value={value} />
    </NodeViewWrapper>
  );
}
