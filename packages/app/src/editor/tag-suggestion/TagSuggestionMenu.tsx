import { plural, t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { TagSuggestionItem } from '../extensions/tag-suggestion';

interface TagSuggestionMenuProps {
  items: TagSuggestionItem[];
  query: string;
  selectedIndex: number;
  onSelect: (item: TagSuggestionItem) => void;
  onHover?: (index: number) => void;
  loading?: boolean;
  error?: string | null;
}

function itemKey(item: TagSuggestionItem): string {
  return item.kind === 'create' ? `create:${item.value}` : `tag:${item.value}`;
}

function announcementText(item: TagSuggestionItem): string {
  if (item.kind === 'create') {
    const tagValue = item.value;
    return t`Create new tag #${tagValue}`;
  }
  const uses = plural(item.count, { one: '# use', other: '# uses' });
  const tagValue = item.value;
  return t`Tag #${tagValue}, ${uses}`;
}

export function TagSuggestionMenu({
  items,
  query,
  selectedIndex,
  onSelect,
  onHover,
  loading = false,
  error = null,
}: TagSuggestionMenuProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const activeDescendant =
    selectedIndex >= 0 && selectedIndex < items.length
      ? `${listboxId}-option-${selectedIndex}`
      : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const options = container.querySelectorAll('[role="option"]');
    const selected = options.item(selectedIndex);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

  if (loading) {
    return (
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="w-64 rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground"
        style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
        onMouseDown={preventFocusSteal}
      >
        <Trans>Loading tags</Trans>
      </div>
    );
  }

  if (items.length === 0) {
    const trimmed = query.trim();
    const emptyMsg =
      error ??
      (trimmed
        ? t`No tags match "${trimmed}". Continue typing to create one.`
        : t`No tags yet. Continue typing to create one.`);

    return (
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="w-64 rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground"
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
      aria-label={t`Tag suggestions`}
      aria-activedescendant={activeDescendant}
      tabIndex={-1}
      onMouseDown={preventFocusSteal}
      className="w-64 overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"
      style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
    >
      {/* Live region announces the selected item on arrow navigation —
          aria-activedescendant on the listbox is inert because focus
          stays in ProseMirror's contenteditable, and screen readers
          only announce activedescendant on the focused element. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedItem ? announcementText(selectedItem) : ''}
      </span>
      {error && (
        <div className="rounded-md px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}
      {items.map((item, idx) => {
        const isSelected = idx === selectedIndex;
        const key = itemKey(item);
        const isCreate = item.kind === 'create';

        return (
          <button
            key={key}
            id={`${listboxId}-option-${idx}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-selected={isSelected}
            data-testid={isCreate ? 'tag-suggestion-create' : `tag-suggestion-tag-${item.value}`}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
              isSelected ? 'bg-accent text-accent-foreground' : ''
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onPointerMove={onHover ? () => onHover(idx) : undefined}
          >
            <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
              #
            </span>
            <span className="truncate font-medium flex-1">{item.value}</span>
            {isCreate ? (
              <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                <Trans>New</Trans>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
