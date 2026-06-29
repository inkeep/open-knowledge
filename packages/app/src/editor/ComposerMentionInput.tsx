
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { clearComposerDraft } from '@/components/composer-draft-store';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
  isComposerEmpty,
  serializeComposerContent,
} from '@/editor/composer-mention/composer-mention';
import { cn } from '@/lib/utils';

/** Whether a seed document has any node with inline content — mirrors the
 *  draft store's `docIsEmpty`, used only to detect a stored draft that the
 *  current composer schema dropped to empty on seed. */
function seedDocHasContent(doc: JSONContent | undefined): boolean {
  const blocks = doc?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.some((block) => Array.isArray(block.content) && block.content.length > 0);
}

export interface ComposerMentionInputHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  /** Replace the field's content with plain text (no chips) — used to prefill a
   *  starter brief the user can then edit. Mirrors the resulting doc into the
   *  shared draft via `onContentChange`. */
  setText: (text: string) => void;
  /** The dispatch payload: instruction prose (chips inline as `@path`) + the
   *  ordered, de-duplicated `@path` mention list. */
  getContent: () => { instruction: string; mentions: string[] };
}

export function ComposerMentionInput({
  ref,
  ariaLabel,
  onEmptyChange,
  onContentChange,
  onMentionsChange,
  onSubmit,
  className,
  placeholder,
  initialDoc,
}: {
  ref?: Ref<ComposerMentionInputHandle>;
  ariaLabel: string;
  onEmptyChange: (isEmpty: boolean) => void;
  /** Fired on every edit with the current ProseMirror document JSON
   *  (`editor.getJSON()`). The host mirrors it into the shared draft store so the
   *  draft — including atomic `@`-mention chips — survives the composer
   *  unmounting between placements. Optional — surfaces that don't share a draft
   *  omit it. */
  onContentChange?: (doc: JSONContent) => void;
  /** Fired on every edit with the current ordered, de-duplicated inline
   *  `@`-mention paths. The host uses it to dedup its top-row file chips against
   *  inline mentions (a file mentioned inline is not also shown as a top chip).
   *  Optional — surfaces with no top-row chips omit it. */
  onMentionsChange?: (mentions: string[]) => void;
  onSubmit: () => void;
  className?: string;
  /** Static placeholder shown while empty (TipTap Placeholder extension). The
   *  bottom composer omits it and overlays its own rotating placeholder. */
  placeholder?: string;
  /** Document-JSON seed for the field on first mount — the shared draft doc, so a
   *  brief (chips included) typed in another placement is restored here as chips,
   *  not literal `@path` text. Applied once at editor creation; later draft
   *  changes flow through the store, not this prop. */
  initialDoc?: JSONContent;
}) {
  const onEmptyChangeRef = useRef(onEmptyChange);
  const onContentChangeRef = useRef(onContentChange);
  const onMentionsChangeRef = useRef(onMentionsChange);
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onEmptyChangeRef.current = onEmptyChange;
    onContentChangeRef.current = onContentChange;
    onMentionsChangeRef.current = onMentionsChange;
    onSubmitRef.current = onSubmit;
  });

  const editor = useEditor({
    extensions: composerMentionExtensions({ placeholder }),
    content: initialDoc ?? undefined,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        class: cn('composer-prosemirror py-1 outline-none'),
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          const suggestionActive = composerMentionSuggestionKey.getState(view.state)?.active;
          if (suggestionActive) return false;
          (view.dom as HTMLElement).blur();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !view.composing) {
          const suggestionActive = composerMentionSuggestionKey.getState(view.state)?.active;
          if (suggestionActive) return false;
          onSubmitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onEmptyChangeRef.current(isComposerEmpty(editor));
      onContentChangeRef.current?.(editor.getJSON());
      onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once seed-integrity check; initialDoc is the one-time draft seed and must not re-trigger this effect.
  useEffect(() => {
    if (!editor) return;
    if (isComposerEmpty(editor) && seedDocHasContent(initialDoc)) {
      console.warn('composer draft was incompatible with the current schema — clearing it');
      clearComposerDraft();
    }
    onEmptyChangeRef.current(isComposerEmpty(editor));
    onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus(),
      blur: () => editor?.commands.blur(),
      clear: () => editor?.commands.clearContent(true),
      setText: (text: string) => {
        if (!editor) return;
        editor.commands.setContent(text);
        onContentChangeRef.current?.(editor.getJSON());
        onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
      },
      getContent: () =>
        editor ? serializeComposerContent(editor) : { instruction: '', mentions: [] },
    }),
    [editor],
  );

  // biome-ignore lint/plugin/no-unportaled-editor-content: standalone single-instance composer editor — not an Activity-pool document editor, and EditorContent is the sole child of its wrapper, so the H6 cross-doc DOM vacuum the portal guards against (precedent #44) cannot apply here.
  return <EditorContent editor={editor} className={className} />;
}
