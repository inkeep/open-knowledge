/**
 * THE shared AI prompt-composer input — one rich text field (a lightweight
 * TipTap editor with `@`-mention chips) rendered by every prompt surface: the
 * bottom "Ask AI" composer, the empty-state create composer, the inline comment
 * composer, and the agent-thread composer. New composer-wide capabilities
 * (attachment paste/drop, `/` slash commands) land HERE, once, gated per host —
 * never as a per-surface fork. It is deliberately NOT the document editor — it
 * never registers in the active-editor registry (that registry stays owned by
 * the real per-doc editors, so `getEditorForDoc` keeps returning the document
 * the user is editing, which the selection-passage feature reads from).
 *
 * The host owns submit/clear/focus via an imperative handle; this component owns
 * only the editor lifecycle and the Enter-submits / Shift+Enter-newline /
 * Escape-blurs key handling. The Enter path guards IME composition, so a CJK
 * commit-Enter never fires a premature submit on any surface. Emptiness (no
 * prose, no chips) is pushed up via `onEmptyChange` so the host can drive the
 * placeholder + send-enabled state.
 */

import { useLingui } from '@lingui/react/macro';
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { clearComposerDraft } from '@/components/composer-draft-store';
import {
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
  /** Focus with the caret at the END of the draft — the card-whitespace
   *  affordance ("click the dead space, continue typing"), matching the
   *  chat-composer convention. Plain `focus()` restores the last selection,
   *  which after a blur can sit anywhere (including before a leading pill). */
  focusEnd: () => void;
  blur: () => void;
  clear: () => void;
  /** Replace the field's content with plain text (no chips) — used to prefill a
   *  starter brief the user can then edit. Mirrors the resulting doc into the
   *  shared draft via `onContentChange`. */
  setText: (text: string) => void;
  /** Append plain text after the existing content, separated by a blank line
   *  (an empty field just takes the text). Newlines in `text` become paragraph
   *  breaks. Existing content — chips included — is left untouched, which is
   *  why hosts that seed a composer mid-draft (a staged selection passage, a
   *  cancelled turn's rescued queue) use this rather than read-modify-`setText`,
   *  which would flatten chips to literal `@path` text. */
  appendText: (text: string) => void;
  /** The dispatch payload: instruction prose (chips inline as `@path`) + the
   *  ordered, de-duplicated `@path` mention list. */
  getContent: () => { instruction: string; mentions: string[] };
}

/** Map plain text onto the composer schema: one paragraph per line, blank
 *  lines as empty paragraphs (both serialize back to `\n`). */
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
  /**
   * Enter (and ⌘/Ctrl+Enter) with the `@`-popup closed.
   *
   * Carries no modifier flag: every host has ONE filing action, so both chords
   * mean the same thing. It briefly reported which one fired, for a second
   * "send now" action on the comment composer that no longer exists — and a flag
   * nobody reads is a flag that drifts from what the keys actually do.
   */
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
  /** Make the field read-only (the agent-thread composer while an archived
   *  thread resumes, or once its agent is gone for good). Content — a draft
   *  written before the flip — is kept, the placeholder stays visible, and the
   *  imperative handle still works; only user editing is off. */
  disabled?: boolean;
  /** `data-testid` for the contenteditable element itself, so tests and the
   *  sessions dock's focus routing address the real textbox. Applied once at
   *  editor creation (it never changes). */
  testId?: string;
  /**
   * The host's slash-command corpus — mounts the `/` typeahead + token-state
   * affordance. Omitted (`undefined`), `/` stays inert text: only surfaces
   * whose dispatch target can execute commands pass this (the agent-thread
   * composer). `null` means the corpus is expected but not yet advertised
   * ("not yet known" — neutral UI); `[]` means the agent advertised zero
   * commands (an honest "none"). Whether the affordance exists is fixed at
   * mount; the list itself is live and may change on any render.
   */
  slashCommands?: SlashCommandItem[] | null;
}) {
  const { t } = useLingui();
  // What the composer should say about the draft's leading `/token`, resolved
  // against the live advertised-command list (null = no token, or no slash
  // affordance on this surface). Recomputed on every edit and on command-list
  // updates; rendered as the hint line under the field — the textual channel
  // that says "unsupported" BEFORE submission (the token decoration is the
  // visual one).
  const [slashHint, setSlashHint] = useState<SlashTokenHint | null>(null);

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
        // `composer-prosemirror` resets the document-editor `.ProseMirror`
        // sizing (200px min-height, the drag-handle margin/padding) so the
        // composer rests at a single slim line — see globals.css.
        class: cn('composer-prosemirror py-1 outline-none'),
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          // While the `@`- or `/`-popup is open, Escape closes it (the owning
          // suggestion plugin handles that) and must not blur the field;
          // otherwise it dismisses.
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
        // Enter submits; Shift+Enter is left to the hardBreak shortcut. Guard IME
        // composition so a CJK commit Enter does not fire the prompt.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !view.composing) {
          // While the `@`- or `/`-popup is open WITH something to commit,
          // Enter selects the highlighted item (the owning suggestion plugin's
          // onKeyDown does that) and must not submit the prompt; returning
          // false lets that handler run. Over an EMPTY picker (unknown `/`
          // command, zero-hit `@` query) the plugin's handler declines Enter,
          // and deferring anyway would fall through to TipTap's core
          // `splitBlock` — a blank line where the user expected a send. The
          // pickers publish their live item count for exactly this guard.
          const suggestionActive =
            composerMentionSuggestionKey.getState(view.state)?.active ||
            composerSlashSuggestionKey.getState(view.state)?.active;
          if (suggestionActive && suggestionHasSelectableItem(view)) return false;
          // Claimed here rather than left to the document's hardBreak binding:
          // this is the composer's own editor instance, so ⌘Enter never reaches
          // the surrounding document keymap.
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
      // Live command list read through the extension's storage (never a
      // captured copy) so a mid-draft `available_commands_update` still
      // resolves the token correctly. No-op surfaces without the extension.
      setSlashHint(resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)));
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

  // `useEditor`'s `editable` option only seeds creation — later flips (an
  // archived thread's resume settling, its agent exiting) have to reach the
  // live instance.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editable = !disabled;
    // Guarded + no `emitUpdate`: editability is not content. Unguarded,
    // `setEditable` defaults to emitting `update`, which pushed a synthetic
    // onUpdate through every composer on mount — a redundant draft-store write
    // for the hosts that mirror content out.
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    // `contenteditable=false` alone tells assistive tech nothing — the element
    // keeps `role="textbox"`, so without this a disabled field still reads as
    // editable (the native `<textarea disabled>` it replaces carried the state
    // natively). Same non-throwing `editorView` reach as the locale repaint.
    const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
    if (!view) return;
    if (disabled) view.dom.setAttribute('aria-disabled', 'true');
    else view.dom.removeAttribute('aria-disabled');
  }, [editor, disabled]);

  // Carry command-list updates into the live editor: the extension list is
  // built once, so a mid-session `available_commands_update` swaps the slash
  // extension's storage (its live channel — options writes land on the fresh
  // copy TipTap's options getter returns) and dispatches a no-op transaction
  // so the token decoration recomputes — decorations only refresh on a
  // transaction, and a list change dispatches none of its own. The hint
  // re-resolves for the same reason.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (setSlashCommands(editor, slashCommands ?? null)) {
      const view = (editor as unknown as { editorView?: ComposerEditorView }).editorView;
      // Changes no document state — cannot enter undo history or fire the
      // host's onUpdate content callbacks.
      if (view) view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    }
    setSlashHint(resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)));
  }, [editor, slashCommands]);

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
      focusEnd: () => editor?.commands.focus('end'),
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
        setSlashHint(
          resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)),
        );
      },
      appendText: (text: string) => {
        if (!editor || text === '') return;
        if (isComposerEmpty(editor)) {
          editor.commands.setContent(textToParagraphs(text));
        } else {
          // A blank-line separator between what was there and what arrived —
          // the serialized instruction reads `existing\n\nappended`.
          editor.commands.insertContentAt(editor.state.doc.content.size, [
            { type: 'paragraph', content: [] },
            ...textToParagraphs(text),
          ]);
        }
        // Same mirroring rationale as `setText`; `onEmptyChange` too, because
        // an append into an empty field flips the host's send-enabled state
        // and `setContent` won't reliably announce it.
        onEmptyChangeRef.current(isComposerEmpty(editor));
        onContentChangeRef.current?.(editor.getJSON());
        onMentionsChangeRef.current?.(serializeComposerContent(editor).mentions);
        setSlashHint(
          resolveSlashTokenHint(composerFirstLineText(editor), getSlashCommands(editor)),
        );
      },
      getContent: () =>
        editor ? serializeComposerContent(editor) : { instruction: '', mentions: [] },
    }),
    [editor],
  );

  return (
    <>
      {/* biome-ignore lint/plugin/no-unportaled-editor-content: standalone single-instance composer editor — not an Activity-pool document editor. EditorContent's own wrapper element still exclusively parents view.dom (the slash hint below is a sibling of that wrapper, never inside it), so the H6 cross-doc DOM vacuum the portal guards against (precedent #44) cannot apply here. */}
      <EditorContent editor={editor} className={className} />
      {/* The textual token-state channel for the UNRECOGNIZED case only: says
          "isn't a command / unsupported" BEFORE submission (the in-field
          decoration is shape+color only). A recognized command needs no line
          here — its argument hint renders as in-field ghost text (the
          terminal-CLI idiom) that disappears once arguments are typed. The
          region is PRE-REGISTERED — mounted empty whenever the surface has a
          slash corpus — because screen readers generally ignore a live region
          that is inserted and populated in the same tick, and the first
          population (the warning) is exactly the one that must land. Empty it
          carries no padding, so it costs no height at rest. */}
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
