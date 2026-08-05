/**
 * The bottom "Ask AI" composer's rich text input: a lightweight TipTap editor
 * with `@`-mention chips. It is deliberately NOT the document editor — it never
 * registers in the active-editor registry (that registry stays owned by the
 * real per-doc editors, so `getEditorForDoc` keeps returning the document the
 * user is editing, which the selection-passage feature reads from).
 *
 * The host owns submit/clear/focus via an imperative handle; this component owns
 * only the editor lifecycle and the Enter-submits / Shift+Enter-newline /
 * Escape-blurs key handling. Emptiness (no prose, no chips) is pushed up via
 * `onEmptyChange` so the host can drive the placeholder + send-enabled state.
 */

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

/**
 * The slice of ProseMirror's view this file needs, duck-typed for the same
 * reason `interaction-layer.tsx` does it: `editor.view` is a throwing proxy
 * during construction and recycle/remount, while `editor.editorView` returns
 * `undefined` when unset — but it is `private` on TipTap's class, so reaching
 * it needs a structural type rather than a member access.
 */
interface ComposerEditorView {
  dom: HTMLElement;
  dispatch: (tr: unknown) => void;
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
  onEscape,
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
  /**
   * Escape, when the `@`-popup is NOT open.
   *
   * Hosts that live inside something dismissable — the comment composer — need
   * Escape to close that thing, and cannot tell from outside whether the popup
   * consumed the key first. Only this side knows, so it decides. Omitted, the
   * field blurs as before.
   */
  onEscape?: () => void;
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
  // Refs carry the latest callbacks into the editor's once-created handlers so
  // they never go stale, without re-creating the editor (and writing the refs in
  // an effect, not during render, keeps React Compiler happy).
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
    extensions: composerMentionExtensions({ placeholder }),
    content: initialDoc ?? undefined,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        // `composer-prosemirror` resets the document-editor `.ProseMirror`
        // sizing (200px min-height, the drag-handle margin/padding) so the
        // composer rests at a single slim line — see globals.css.
        class: cn('composer-prosemirror py-1 outline-none'),
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          // While the `@`-popup is open, Escape closes it (suggestion plugin
          // owns that) and must not blur the field; otherwise it dismisses.
          const suggestionActive = composerMentionSuggestionKey.getState(view.state)?.active;
          if (suggestionActive) return false;
          if (onEscapeRef.current !== undefined) {
            onEscapeRef.current();
            return true;
          }
          (view.dom as HTMLElement).blur();
          return true;
        }
        // Enter submits; Shift+Enter is left to the hardBreak shortcut. Guard IME
        // composition so a CJK commit Enter does not fire the prompt.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !view.composing) {
          // While the `@`-popup is open, Enter commits the highlighted item (the
          // suggestion plugin's onKeyDown owns that) and must not submit the
          // prompt; returning false lets that handler run.
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

  // Repaint the chrome the editor captured at construction when the interface
  // language changes. Two separate mechanisms, because they live in different
  // layers: the placeholder is a ProseMirror decoration, which only recomputes
  // on a transaction — and a locale switch dispatches none — while `aria-label`
  // is a DOM attribute TipTap writes once from `editorProps`. Without this the
  // composer keeps whatever language was active when it mounted, which reads as
  // an untranslated string rather than a stale one.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // Re-point the extension's own option rather than rebuilding the editor,
    // which would discard the user's draft. Everything here runs in an effect
    // because React Compiler rejects both a ref write and a ref-reading closure
    // during render, which is what a getter-based placeholder would need.
    const placeholderExtension = editor.extensionManager.extensions.find(
      (extension) => extension.name === 'placeholder',
    );
    if (placeholderExtension) {
      (placeholderExtension.options as { placeholder?: string }).placeholder = placeholder ?? '';
    }
    // `editor.view` is a throwing proxy during recycle/remount, so reach the
    // non-throwing `editorView` field the same duck-typed way `interaction-
    // layer.tsx` does — it is private on the class but returns `undefined`
    // rather than throwing when unset, which is the property that matters here.
    const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
    if (!view) return;
    view.dom.setAttribute('aria-label', ariaLabel ?? '');
    // Placeholder decorations only recompute on a transaction and a locale
    // switch dispatches none. This one changes no document state, so it cannot
    // enter undo history or fire the host's onUpdate content callbacks.
    view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, placeholder, ariaLabel]);

  // Seed the host's empty-state from the initial draft text. `useEditor` does
  // not fire `onUpdate` for the `content` seed, so without this a restored draft
  // would leave the placeholder showing + Send disabled until the first
  // keystroke. Runs once the editor instance resolves (it is stable thereafter).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once seed-integrity check; initialDoc is the one-time draft seed and must not re-trigger this effect.
  useEffect(() => {
    if (!editor) return;
    // A stored draft whose JSON the current composer schema can't represent
    // seeds to an empty editor (TipTap drops unknown nodes/marks silently). Log
    // it and clear the stale draft so the truncation is visible and not re-seeded
    // on every future mount, rather than leaving a silently-empty field.
    if (isComposerEmpty(editor) && seedDocHasContent(initialDoc)) {
      console.warn('composer draft was incompatible with the current schema — clearing it');
      clearComposerDraft();
    }
    onEmptyChangeRef.current(isComposerEmpty(editor));
    // Emit the seeded inline-mention set so the host's top-row dedup reflects a
    // restored draft's `@`-mention chips on first mount (no `onUpdate` fires for
    // the `content` seed).
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
        // `setContent` does not reliably fire `onUpdate`, so mirror the resulting
        // doc into the shared draft + inline-mention set here — otherwise a
        // prefilled starter brief wouldn't carry to the other placement.
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
