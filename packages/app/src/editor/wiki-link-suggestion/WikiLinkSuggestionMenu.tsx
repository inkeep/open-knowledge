import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { FilePlus2 } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { WikiLinkSuggestionItem } from '../extensions/wiki-link-suggestion';
import { getFileIcon } from '../registry/file-icons';

/**
 * Icon for a non-anchor suggestion row, mirroring the sidebar via
 * {@link getFileIcon}: a page → document glyph, an asset → media glyph by its
 * extension, a `create` row → the new-file glyph. Anchors render their own
 * `H{level}` badge and never reach here.
 */
function itemIcon(item: WikiLinkSuggestionItem) {
  if (item.kind === 'create') {
    return <FilePlus2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  const assetExt = item.kind === 'asset' ? (item.path.split('.').pop() ?? '') : undefined;
  const Icon = getFileIcon({ kind: item.kind, assetExt });
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

interface WikiLinkSuggestionMenuProps {
  items: WikiLinkSuggestionItem[];
  query: string;
  selectedIndex: number;
  onSelect: (item: WikiLinkSuggestionItem) => void;
  loading?: boolean;
  error?: string | null;
  mode?: 'page' | 'anchor';
  pageTarget?: string;
  anchorQuery?: string;
  /**
   * True when the suggestion list was truncated at the per-popup cap
   * (`MAX_ITEMS` in `wiki-link-suggestion.ts`). Menu renders a passive footer
   * telling the user the visible set may not be exhaustive — typing more
   * characters narrows the corpus via the same `searchWorkspaceCorpus` path.
   */
  hasMore?: boolean;
}

function itemKey(item: WikiLinkSuggestionItem): string {
  if (item.kind === 'asset') return item.target;
  return item.kind === 'anchor' ? `${item.docName}#${item.slug}` : item.docName;
}

/** Screen-reader announcement text for the currently-selected item. */
function announcementText(item: WikiLinkSuggestionItem): string {
  if (item.kind === 'anchor') {
    const { level, text } = item;
    return t`Heading H${level}: ${text}`;
  }
  if (item.kind === 'asset') {
    const { title } = item;
    return t`Asset: ${title}`;
  }
  if (item.kind === 'create') return item.actionLabel;
  return item.title;
}

export function WikiLinkSuggestionMenu({
  items,
  query,
  selectedIndex,
  onSelect,
  loading = false,
  error = null,
  mode = 'page',
  pageTarget = '',
  anchorQuery = '',
  hasMore = false,
}: WikiLinkSuggestionMenuProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const activeDescendant =
    selectedIndex >= 0 && selectedIndex < items.length
      ? `${listboxId}-option-${selectedIndex}`
      : undefined;

  // Scroll selected item into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const options = container.querySelectorAll('[role="option"]');
    const selected = options.item(selectedIndex);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Prevent any click on the popup (buttons or empty space) from stealing focus
  // from the editor — without this, Backspace events go to the popup instead.
  const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

  if (loading) {
    return (
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="w-80 max-w-[min(28rem,90vw)] rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground"
        style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
        onMouseDown={preventFocusSteal}
      >
        {mode === 'anchor' ? t`Loading headings for ${pageTarget}` : t`Loading pages`}
      </div>
    );
  }

  if (items.length === 0) {
    const trimmedAnchorQuery = anchorQuery.trim();
    const trimmedQuery = query.trim();
    const emptyMsg =
      error ??
      (mode === 'anchor'
        ? trimmedAnchorQuery
          ? t`No headings match "${trimmedAnchorQuery}"`
          : t`No headings in ${pageTarget}`
        : trimmedQuery
          ? t`No pages found for "${trimmedQuery}"`
          : t`No pages found`);

    return (
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="w-80 max-w-[min(28rem,90vw)] rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground"
        style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
        onMouseDown={preventFocusSteal}
      >
        {emptyMsg}
      </div>
    );
  }

  const selectedItem =
    selectedIndex >= 0 && selectedIndex < items.length ? items[selectedIndex] : null;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={mode === 'anchor' ? t`Heading suggestions` : t`Wiki link suggestions`}
      aria-activedescendant={activeDescendant}
      tabIndex={-1}
      onMouseDown={preventFocusSteal}
      className="w-80 max-w-[min(28rem,90vw)] overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"
      style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
    >
      {/*
        Live region announces the selected item on arrow navigation. Required
        because aria-activedescendant on the listbox is inert — focus stays in
        ProseMirror's contenteditable, and screen readers only announce
        activedescendant on the focused element.
      */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedItem ? announcementText(selectedItem) : ''}
      </span>
      {error && (
        <div className="rounded-md px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}
      {mode === 'anchor' && (
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {pageTarget}
        </div>
      )}
      {items.map((item, idx) => {
        const isSelected = idx === selectedIndex;
        const key = itemKey(item);

        if (item.kind === 'anchor') {
          return (
            <button
              key={key}
              id={`${listboxId}-option-${idx}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
                isSelected ? 'bg-accent text-accent-foreground' : ''
              }`}
              style={{ paddingLeft: `${(item.level - 1) * 10 + 8}px` }}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
            >
              <span className="w-6 shrink-0 font-mono text-[10px] text-muted-foreground">
                H{item.level}
              </span>
              <span className="truncate font-medium">{item.text}</span>
            </button>
          );
        }

        return (
          <button
            key={key}
            id={`${listboxId}-option-${idx}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-selected={isSelected}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
              isSelected ? 'bg-accent text-accent-foreground' : ''
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
          >
            <span className="mt-0.5">{itemIcon(item)}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">
                {item.kind === 'create' ? item.actionLabel : item.title}
              </span>
              {/*
                Secondary path/docName line. Wrap (break-all + clamp) rather
                than end-truncate so the discriminating tail of a long path
                stays visible — the wider popup gives it room.
              */}
              {item.kind === 'page' && item.title !== item.docName && (
                <span className="line-clamp-2 break-all text-xs text-muted-foreground">
                  {item.docName}
                </span>
              )}
              {item.kind === 'asset' && (
                <span className="line-clamp-2 break-all text-xs text-muted-foreground">
                  {item.path}
                </span>
              )}
              {item.kind === 'create' && (
                <span className="line-clamp-2 break-all text-xs text-muted-foreground">
                  {item.docName}.md
                </span>
              )}
            </span>
          </button>
        );
      })}
      {hasMore && (
        // Passive overflow hint. Non-interactive (no `role="option"`, no
        // selectedIndex slot) so arrow-key navigation skips it and the live
        // region's `announcementText` never reads it as a selectable item.
        // Renders OUTSIDE the items map so the `selectedIndex`-keyed
        // `<button>` indices stay 1:1 with the items array.
        <div
          data-prop-suggestion-more-hint=""
          className="border-t border-border mt-1 px-2 py-1.5 text-xs text-muted-foreground"
        >
          {mode === 'anchor'
            ? t`Showing top ${items.length} headings — keep typing to narrow`
            : t`Showing top ${items.length} matches — keep typing to narrow`}
        </div>
      )}
    </div>
  );
}
