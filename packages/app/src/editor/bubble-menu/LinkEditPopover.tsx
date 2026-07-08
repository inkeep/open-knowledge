import { Trans, useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { ArrowUpRight, CornerDownLeft, Link, Trash2 } from 'lucide-react';
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePageList } from '@/components/PageListContext';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { detectClipboardPrefillUrl } from '../clipboard/lone-url';
import { setPendingLinkEdit } from '../extensions/link-edit-autoopen';
import { getInteractionLayer } from '../interaction-layer-host';
import { buildCurrentRelativeMarkdownHref, openHashHrefInNewTab } from '../internal-link-helpers';
import { type LinkPathSuggestion, LinkPathSuggestionInput } from '../link-path-suggestions';
import { assertNeverAddLinkAction, resolveAddLinkShortcutAction } from './bubble-menu-state';
import {
  emitOpenLinkEditPopover,
  subscribeToOpenLinkEditPopover,
} from './link-edit-popover-events';

function initialLinkInputUrl(editor: Editor): string {
  return editor.state.selection.empty && editor.isActive('link')
    ? (editor.getAttributes('link').href ?? '')
    : '';
}

/**
 * Best-effort clipboard pre-fill for a just-opened, still-empty URL input.
 * Denied/unavailable clipboard and non-URL content degrade the same way —
 * the input stays empty, no error surfaced. The functional guard applies
 * the pre-fill only while the input is still untouched, so a value the
 * user has begun typing always wins over a late clipboard resolve; the
 * select() makes the guess replaceable in one gesture when it does land.
 */
async function prefillUrlFromClipboard(
  inputRef: RefObject<HTMLInputElement | null>,
  setUrl: Dispatch<SetStateAction<string>>,
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
    // Expected denials (permission, insecure context, empty clipboard) arrive
    // as DOMExceptions and degrade silently by design. Anything else — a
    // polyfill or CSP failure that would make pre-fill always-empty — warns
    // (debug is suppressed by default console filters) so it is
    // field-diagnosable.
    if (!(error instanceof DOMException)) {
      console.warn('[link-popover] clipboard pre-fill read failed unexpectedly', error);
    }
    return;
  }
  const href = detectClipboardPrefillUrl(text);
  if (href === null) return;
  setUrl((prev) => (prev === '' ? href : prev));
  requestAnimationFrame(() => {
    const input = inputRef.current;
    if (input && input.value === href) {
      input.select();
    }
  });
}

// Shared open path for the Link button and the programmatic-open seam. The
// clipboard read fires only when the input opens empty (the add case): an
// edit-open already carries the existing href, and reading a value we would
// discard could still cost the user a browser permission prompt.
function openLinkInput(
  editor: Editor,
  inputRef: RefObject<HTMLInputElement | null>,
  setUrl: Dispatch<SetStateAction<string>>,
  setShowInput: Dispatch<SetStateAction<boolean>>,
): void {
  const initial = initialLinkInputUrl(editor);
  setUrl(initial);
  setShowInput(true);
  if (initial === '') {
    void prefillUrlFromClipboard(inputRef, setUrl);
  }
}

export function LinkEditPopover({
  editor,
  shortcutEnabled = false,
}: {
  editor: Editor;
  shortcutEnabled?: boolean;
}) {
  const { t } = useLingui();
  const [showInput, setShowInput] = useState(false);
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { folderPaths, loading, pages } = usePageList();

  const isLinkActive = editor.state.selection.empty && editor.isActive('link');
  const currentUrl = editor.getAttributes('link').href ?? '';

  // Programmatic-open seam — same open path as the Link button below (focus
  // rides the showInput effect's rAF). Gated on `shortcutEnabled` because the
  // event is window-scoped and every pooled editor mounts its own popover —
  // only the active document's instance may react.
  useEffect(() => {
    return subscribeToOpenLinkEditPopover(() => {
      if (!shortcutEnabled) return;
      openLinkInput(editor, inputRef, setUrl, setShowInput);
    });
  }, [shortcutEnabled, editor]);

  // ⌘K dual-role claim. Capture phase deterministically beats the command
  // palette's window-bubble listener; the claim stands only while this doc's
  // WYSIWYG owns focus AND a link affordance applies (non-empty text
  // selection → popover; caret inside a link → chip edit surface). Any other
  // ⌘K — source mode, no selection, palette/input focus — falls through and
  // stays the palette. Mirrors the Edit-with-AI capture-listener pattern.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shortcutEnabled) return;
      if (!matchesKeyboardShortcut(event, 'add-link')) return;
      // `editor.view` is a throwing proxy while `editor.editorView` is unset
      // (PM construction, Activity recycle/remount) — and this window-capture
      // listener is registered whenever the shortcut is enabled, so a ⌘K can
      // land in exactly that window. Read the non-throwing field structurally
      // (TipTap types it private; same duck-typed access as the
      // InteractionLayer's getEditorDom): unset reads as "not focused" and
      // falls through cleanly to the palette.
      const liveView = (editor as unknown as { editorView?: { hasFocus(): boolean } | null })
        .editorView;
      if (!liveView?.hasFocus()) return;
      const action = resolveAddLinkShortcutAction(editor);
      if (action === null) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      switch (action.kind) {
        case 'open-popover':
          emitOpenLinkEditPopover();
          return;
        case 'edit-link': {
          // Chip edit spine shared with the slash-command Link insert: flag
          // the mark id for auto-edit, then activate its prop panel next frame.
          const { markId } = action;
          setPendingLinkEdit(markId);
          requestAnimationFrame(() => {
            getInteractionLayer(editor).setActiveNode(markId);
          });
          return;
        }
        default:
          assertNeverAddLinkAction(action);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [shortcutEnabled, editor]);

  // Reset link input when selection collapses (bubble menu hides)
  useEffect(() => {
    function onSelectionUpdate() {
      if (editor.state.selection.empty) {
        setShowInput(false);
      }
    }
    editor.on('selectionUpdate', onSelectionUpdate);
    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
    };
  }, [editor]);

  useEffect(() => {
    if (!showInput) return;
    // The input lives inside the floating bubble menu, which stays
    // visibility:hidden (unfocusable — focus() is a silent no-op) until
    // floating-ui finishes positioning, an unbounded number of frames after
    // mount. So a single rAF focus never lands. Retry each frame until focus
    // actually LANDS once, then stop permanently — never re-grab afterwards,
    // so the loop can't fight the user. Cleanup cancels on close/unmount; the
    // attempt cap is a backstop only.
    let cancelled = false;
    let frameId = 0;
    const focusInput = (attempts: number): void => {
      if (cancelled) return;
      const el = inputRef.current;
      if (el) {
        el.focus();
        if (document.activeElement === el) return;
      }
      if (attempts < 60) {
        frameId = requestAnimationFrame(() => focusInput(attempts + 1));
      } else {
        console.warn('[link-popover] URL input never became focusable');
      }
    };
    frameId = requestAnimationFrame(() => focusInput(0));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [showInput]);

  function applyLink() {
    if (url.trim()) {
      editor.chain().focus().setLink({ href: url.trim() }).run();
    } else if (isLinkActive) {
      editor.chain().focus().unsetLink().run();
    }
    setShowInput(false);
  }

  function removeLink() {
    editor.chain().focus().unsetLink().run();
    setShowInput(false);
  }

  function handlePathSuggestionSelect(suggestion: LinkPathSuggestion) {
    setUrl(buildCurrentRelativeMarkdownHref(suggestion.path, null));
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setShowInput(false);
      editor.chain().focus().run();
    }
  }

  if (showInput) {
    return (
      <div className="flex items-center gap-0.5">
        <div className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <LinkPathSuggestionInput
            ref={inputRef}
            type="text"
            placeholder={t`Paste link`}
            value={url}
            pages={pages}
            folderPaths={folderPaths}
            loading={loading}
            onValueChange={setUrl}
            onSuggestionSelect={handlePathSuggestionSelect}
            onKeyDown={handleKeyDown}
            aria-label={t`Link URL`}
            className="h-5 w-44 rounded-none border-none bg-transparent px-0 py-0 text-sm placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Apply link`}
            onClick={() => {
              applyLink();
            }}
          >
            <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </div>
        {isLinkActive && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Open link in new tab`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    openHashHrefInNewTab(currentUrl);
                  }}
                >
                  <ArrowUpRight className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                <Trans>Open link in new tab</Trans>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Remove link`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    removeLink();
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                <Trans>Remove link</Trans>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Insert link`}
          className={isLinkActive ? 'bg-accent text-primary' : 'text-accent-foreground'}
          onMouseDown={(e) => {
            e.preventDefault();
            openLinkInput(editor, inputRef, setUrl, setShowInput);
          }}
        >
          <Link className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <Trans>Link</Trans>
        <Kbd>{formatShortcut('add-link')}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
