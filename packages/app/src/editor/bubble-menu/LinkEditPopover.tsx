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

async function prefillUrlFromClipboard(
  inputRef: RefObject<HTMLInputElement | null>,
  setUrl: Dispatch<SetStateAction<string>>,
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
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

  useEffect(() => {
    return subscribeToOpenLinkEditPopover(() => {
      if (!shortcutEnabled) return;
      openLinkInput(editor, inputRef, setUrl, setShowInput);
    });
  }, [shortcutEnabled, editor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shortcutEnabled) return;
      if (!matchesKeyboardShortcut(event, 'add-link')) return;
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
