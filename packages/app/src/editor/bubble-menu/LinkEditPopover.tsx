import { Trans, useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { ArrowUpRight, CornerDownLeft, Link, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { usePageList } from '@/components/PageListContext';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut } from '@/lib/keyboard-shortcuts';
import { buildCurrentRelativeMarkdownHref, openHashHrefInNewTab } from '../internal-link-helpers';
import { type LinkPathSuggestion, LinkPathSuggestionInput } from '../link-path-suggestions';

export function LinkEditPopover({ editor }: { editor: Editor }) {
  const { t } = useLingui();
  const [showInput, setShowInput] = useState(false);
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { folderPaths, loading, pages } = usePageList();

  const isLinkActive = editor.state.selection.empty && editor.isActive('link');
  const currentUrl = editor.getAttributes('link').href ?? '';

  function getInitialUrlForLinkInput() {
    return editor.state.selection.empty && editor.isActive('link')
      ? (editor.getAttributes('link').href ?? '')
      : '';
  }

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
    if (showInput) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
            setUrl(getInitialUrlForLinkInput());
            setShowInput(true);
          }}
        >
          <Link className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <Trans>Link</Trans>
        <Kbd>{formatShortcut('command-palette')}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
