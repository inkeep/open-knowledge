/**
 * "Ask AI" button for the WYSIWYG bubble menu. Sends the selected passage into
 * the active shell (e.g. a running `claude` TUI) via
 * `requestActiveTerminalInput` — the host owns PTY state and launches a fresh
 * Claude tab when none is open, either way pre-loaded with the same grounded
 * selection prompt (`composeSelectionPrompt` builds it: doc named as an
 * `@`-mention plus the passage inline, or a locus "read via OK MCP" pointer
 * when it is large) — so the running agent can place the passage in its doc
 * instead of receiving an unattributed blob. With no selection to send
 * (caret-only or no active doc) it opens the docked "Ask AI" composer, the
 * same path the ⌘L shortcut runs; the composer pins the live selection as a
 * removable context pill.
 *
 * Mounted only in the bubble menu's text branch: image / file node selections
 * swap the whole bar to a separate control tree, and selection handoff does
 * not apply to leaf media nodes.
 *
 * Available on every platform — the button just opens the (now cross-platform)
 * composer. Hidden only when OK is embedded inside an agent host, where the
 * composer is not shown. The ⌘/Ctrl+Shift+I keyboard shortcut, however, stays
 * macOS-only: on Windows/Linux that chord is the browser DevTools shortcut, and
 * hijacking it for end users is worse than the missing shortcut.
 *
 * The open+focus intent is dispatched through `emitOpenAskAiComposer`, a
 * window CustomEvent that `BottomComposer` subscribes to — so the button and ⌘L
 * share exactly one open+focus implementation rather than duplicating it.
 */

import { Trans } from '@lingui/react/macro';
import { isMacOS } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { emitOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { composeTerminalSelectionPaste } from '@/components/handoff/compose-terminal-selection';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { serializeWysiwygSelection } from '../edit-with-ai-selection';
import { getEditorDocName } from '../extensions/doc-context';

function isNativeTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Keep this narrower than `isEditableShortcutTarget`: ProseMirror's editable
  // root is contentEditable, and selected editor text still needs this shortcut.
  const tagName = target.tagName.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

export function EditWithAiBubbleButton({
  editor,
  shortcutEnabled = false,
}: {
  editor: Editor;
  shortcutEnabled?: boolean;
}): ReactNode {
  const isEmbedded = useIsEmbedded();
  // The button is available on every platform (it opens the cross-platform
  // composer); it's hidden only inside an embedded agent host, where the
  // composer is not shown.
  if (isEmbedded) return null;

  return <EditWithAiBubbleMenu editor={editor} shortcutEnabled={shortcutEnabled} />;
}

function EditWithAiBubbleMenu({
  editor,
  shortcutEnabled,
}: {
  editor: Editor;
  shortcutEnabled: boolean;
}): ReactNode {
  // The ⌘/Ctrl+Shift+I shortcut stays macOS-only: on Windows/Linux that chord is
  // the browser DevTools shortcut, so binding a capture-phase override there
  // would steal DevTools from end users. The button itself is cross-platform.
  const shortcutBound = isMacOS();
  useEffect(() => {
    if (!shortcutBound) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shortcutEnabled) return;
      if (!matchesKeyboardShortcut(event, 'edit-with-ai')) return;
      if (isNativeTextControl(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      emitOpenAskAiComposer();
    };

    // Capture phase overrides Chrome DevTools' Cmd+Shift+I before it fires (macOS
    // Chrome uses Cmd+Opt+I for DevTools, so this chord is free there).
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [shortcutEnabled, shortcutBound]);

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="edit-with-ai-bubble-button"
        className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
        // Send the selected passage into the active shell (host reuses a live
        // PTY or launches a fresh Claude tab) as a GROUNDED prompt (see
        // `composeTerminalSelectionPaste`). Caret-only / empty selection (or
        // no active doc to ground against) has nothing to send, so open the
        // composer.
        //
        // Deferred a frame: the composer focus (empty-selection branch) and
        // the terminal focus fire synchronously inside this click, before
        // ProseMirror's own focus handling on the trailing mouseup, which
        // would steal the caret back to the doc and leave the composer
        // unfocused. Reading the selection first keeps the passage from the
        // click moment even though the write runs later. Mirrors
        // LinkEditPopover's rAF focus.
        onClick={() => {
          const docName = getEditorDocName(editor);
          const selectionMarkdown = serializeWysiwygSelection(editor);
          requestAnimationFrame(() => {
            if (docName === null || selectionMarkdown.trim() === '') {
              emitOpenAskAiComposer();
              return;
            }
            requestActiveTerminalInput(composeTerminalSelectionPaste(docName, selectionMarkdown));
          });
        }}
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>
          <Trans>Ask AI</Trans>
        </span>
      </Button>
    </>
  );
}
