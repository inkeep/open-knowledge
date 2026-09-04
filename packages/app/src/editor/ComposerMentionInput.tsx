import { useLingui } from '@lingui/react/macro';
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { clearComposerDraft } from '@/components/composer-draft-store';
import {
  type ComposerAttachmentPart,
  composerMentionExtensions,
  composerMentionSuggestionKey,
  isComposerEmpty,
  serializeComposerContent,
} from '@/editor/composer-mention/composer-mention';
import {
  composerFirstLineText,
  composerSlashSuggestionKey,
  getSlashCommands,
  resolveSlashTokenHint,
  type SlashCommandItem,
  type SlashTokenHint,
  setSlashCommands,
} from '@/editor/composer-mention/composer-slash-command';
import { suggestionHasSelectableItem } from '@/editor/extensions/suggestion-floating-ui';
import { cn } from '@/lib/utils';

function seedDocHasContent(doc: JSONContent | undefined): boolean {
  const blocks = doc?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.some((block) => Array.isArray(block.content) && block.content.length > 0);
}

interface ComposerEditorView {
  dom: HTMLElement;
  dispatch: (tr: unknown) => void;
}

export interface ComposerMentionInputHandle {
  focus: () => void;
  focusEnd: () => void;
  blur: () => void;
  clear: () => void;
  setText: (text: string) => void;
  appendText: (text: string) => void;
  getContent: () => {
    instruction: string;
    mentions: string[];
    attachments: ComposerAttachmentPart[];
  };
  openMentionPicker: () => void;
}

function textToParagraphs(text: string): JSONContent[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line === '' ? [] : [{ type: 'text', text: line }],
  }));
}

export function ComposerMentionInput({
  ref,
  ariaLabel,
  onEmptyChange,
  onContentChange,
  onMentionsChange,
  onSubmit,
  onEscape,
  className,
  placeholder,
  initialDoc,
  disabled = false,
  testId,
  slashCommands,
}: {
  ref?: Ref<ComposerMentionInputHandle>;
  ariaLabel: string;
  onEmptyChange: (isEmpty: boolean) => void;
  onContentChange?: (doc: JSONContent) => void;
  onMentionsChange?: (mentions: string[]) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  className?: string;
  placeholder?: string;
  initialDoc?: JSONContent;
  disabled?: boolean;
  testId?: string;
  slashCommands?: SlashCommandItem[] | null;
}) {
  const { t } = useLingui();
  const [slashHint, setSlashHint] = useState<SlashTokenHint | null>(null);

  const onEmptyChangeRef = useRef(onEmptyChange);
  const onContentChangeRef = useRef(onContentChange);
  const onMentionsChangeRef = useRef(onMentionsChange);
  const onSubmitRef = useRef(onSubmit);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEmptyChangeRef.current = onEmptyChange;
    onContentChangeRef.current = onContentChange;
    onMentionsChangeRef.current = onMentionsChange;
    onSubmitRef.current = onSubmit;
    onEscapeRef.current = onEscape;
  });

  const editor = useEditor({
    extensions: composerMentionExtensions({ placeholder, slashCommands }),
    content: initialDoc ?? undefined,
    immediatelyRender: true,
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        ...(testId !== undefined ? { 'data-testid': testId } : {}),
        class: cn('composer-prosemirror py-1 outline-none'),
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          const suggestionActive =
            composerMentionSuggestionKey.getState(view.state)?.active ||
            composerSlashSuggestionKey.getState(view.state)?.active;
          if (suggestionActive) return false;
          if (onEscapeRef.current !== undefined) {
            onEscapeRef.current();
            return true;
          }
          (view.dom as HTMLElement).blur();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !view.composing) {
          const suggestionActive =
            composerMentionSuggestionKey.getState(view.state)?.active ||
            composerSlashSuggestionKey.getState(view.state)?.active;
          if (suggestionActive && suggestionHasSelectableItem(view)) return false;
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
      setSlashHint(resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)));
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const placeholderExtension = editor.extensionManager.extensions.find(
      (extension) => extension.name === 'placeholder',
    );
    if (placeholderExtension) {
      (placeholderExtension.options as { placeholder?: string }).placeholder = placeholder ?? '';
    }
    const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
    if (!view) return;
    view.dom.setAttribute('aria-label', ariaLabel ?? '');
    view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, placeholder, ariaLabel]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editable = !disabled;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
    if (!view) return;
    if (disabled) view.dom.setAttribute('aria-disabled', 'true');
    else view.dom.removeAttribute('aria-disabled');
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (setSlashCommands(editor, slashCommands ?? null)) {
      const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
      if (view) view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    }
    setSlashHint(resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)));
  }, [editor, slashCommands]);

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
      focusEnd: () => editor?.commands.focus('end'),
      blur: () => editor?.commands.blur(),
      clear: () => editor?.commands.clearContent(true),
      setText: (text: string) => {
        if (!editor) return;
        editor.commands.setContent(textToParagraphs(text));
        onEmptyChangeRef.current(isComposerEmpty(editor));
        onContentChangeRef.current?.(editor.getJSON());
        onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
        setSlashHint(
          resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)),
        );
      },
      appendText: (text: string) => {
        if (!editor || text === '') return;
        if (isComposerEmpty(editor)) {
          editor.commands.setContent(textToParagraphs(text));
        } else {
          editor.commands.insertContentAt(editor.state.doc.content.size, [
            { type: 'paragraph', content: [] },
            ...textToParagraphs(text),
          ]);
        }
        onEmptyChangeRef.current(isComposerEmpty(editor));
        onContentChangeRef.current?.(editor.getJSON());
        onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
        setSlashHint(
          resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)),
        );
      },
      getContent: () =>
        editor
          ? serializeComposerContent(editor)
          : { instruction: '', mentions: [], attachments: [] },
      openMentionPicker: () => {
        if (!editor) return;
        editor.chain().focus().insertContent('@').run();
      },
    }),
    [editor],
  );

  return (
    <>
      {/* biome-ignore lint/plugin/no-unportaled-editor-content: standalone single-instance composer editor — not an Activity-pool document editor. EditorContent's own wrapper element still exclusively parents view.dom (the slash hint below is a sibling of that wrapper, never inside it), so the H6 cross-doc DOM vacuum the portal guards against (precedent #44) cannot apply here. */}
      <EditorContent editor={editor} className={className} />
      {}
      {slashCommands !== undefined ? (
        <p
          className={cn(
            'truncate px-2.5 text-xs text-muted-foreground',
            slashHint?.kind === 'unknown' && 'pb-1',
          )}
          aria-live="polite"
          aria-atomic="true"
          data-testid="composer-slash-hint"
        >
          {slashHint?.kind !== 'unknown'
            ? null
            : slashHint.agentHasCommands
              ? t`/${slashHint.name} isn't a command this agent offers — it will be sent as plain text`
              : t`This agent doesn't offer slash commands — your message will be sent as plain text`}
        </p>
      ) : null}
    </>
  );
}
