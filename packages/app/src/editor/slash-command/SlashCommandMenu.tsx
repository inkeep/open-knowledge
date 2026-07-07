import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { SlashCommandItem } from './items';

interface SlashCommandMenuProps {
  items: SlashCommandItem[];
  selectedIndex: number;
  categoryLabels: Record<string, string>;
  onSelect: (item: SlashCommandItem) => void;
  /**
   * Called when the user hovers an option. The extension lifts this into the
   * same `selectedIndex` cursor that arrow keys drive, so keyboard and mouse
   * navigation share one source of truth (mirrors Notion's slash menu).
   */
  onHoverIndex?: (index: number) => void;
}

export function SlashCommandMenu({
  items,
  selectedIndex,
  categoryLabels,
  onSelect,
  onHoverIndex,
}: SlashCommandMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const { t } = useLingui();
  const activeDescendant =
    selectedIndex >= 0 && selectedIndex < items.length
      ? `${listboxId}-option-${selectedIndex}`
      : undefined;

  // Prevent any click on the popup (buttons or empty space) from stealing focus
  // from the editor — without this, Backspace events go to the popup instead.
  const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

  // Scroll selected item into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const options = container.querySelectorAll('[role="option"]');
    const selected = options.item(selectedIndex);
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div
        ref={containerRef}
        role="status"
        aria-live="polite"
        className="w-56 rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground"
        style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
        onMouseDown={preventFocusSteal}
      >
        <Trans>No results</Trans>
      </div>
    );
  }

  // Group by category, preserving order
  const categories: { key: string; items: SlashCommandItem[] }[] = [];
  let flatIndex = 0;
  const indexMap = new Map<SlashCommandItem, number>();

  for (const item of items) {
    indexMap.set(item, flatIndex++);
    const existing = categories.find((c) => c.key === item.category);
    if (existing) {
      existing.items.push(item);
    } else {
      categories.push({ key: item.category, items: [item] });
    }
  }

  const selectedItem =
    selectedIndex >= 0 && selectedIndex < items.length ? items[selectedIndex] : null;
  // Reserve preview-panel width whenever ANY item in the current filtered set
  // has a preview, so navigating between preview/no-preview items doesn't
  // oscillate the popup width (and floating-ui's computePosition doesn't shift
  // the popup horizontally on every selection change).
  const hasAnyPreview = items.some((item) => item.preview);

  return (
    <div className="flex items-start gap-2">
      <div
        ref={containerRef}
        role="listbox"
        aria-label={t`Slash commands`}
        aria-activedescendant={activeDescendant}
        tabIndex={-1}
        onMouseDown={preventFocusSteal}
        className="w-56 overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"
        style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
      >
        {/*
          Live region announces the selected item on arrow navigation. Required
          because aria-activedescendant on the listbox is inert — focus stays in
          ProseMirror's contenteditable, and screen readers only announce
          activedescendant on the focused element.
        */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {selectedItem
            ? `${selectedItem.label}${selectedItem.preview ? `. ${selectedItem.preview.description}` : ''}`
            : ''}
        </span>
        {categories.map((cat) => (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA listbox pattern requires role="group" for option groups — <fieldset> is non-standard inside role="listbox"
          <div key={cat.key} role="group" aria-labelledby={`${listboxId}-group-${cat.key}`}>
            <div
              id={`${listboxId}-group-${cat.key}`}
              className="px-2 py-1.5 text-xs font-semibold text-muted-foreground"
            >
              {categoryLabels[cat.key] ?? cat.key}
            </div>
            {cat.items.map((item) => {
              const idx = indexMap.get(item) ?? 0;
              const isSelected = idx === selectedIndex;
              const Icon = item.icon;
              return (
                <button
                  key={item.name}
                  id={`${listboxId}-option-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
                    isSelected ? 'bg-accent text-accent-foreground' : ''
                  }`}
                  onMouseEnter={() => onHoverIndex?.(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{item.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {hasAnyPreview ? (
        <aside
          aria-hidden="true"
          onMouseDown={preventFocusSteal}
          className={`w-64 rounded-lg border bg-popover p-2 shadow-md ${
            selectedItem?.preview ? '' : 'invisible'
          }`}
        >
          {selectedItem?.preview ? (
            <>
              <div className="mb-2 flex aspect-5/3 items-center justify-center overflow-hidden rounded-md bg-muted/40 p-3 *:max-h-full *:max-w-full [&_img]:size-full [&_img]:rounded-md [&_img]:object-contain">
                {selectedItem.preview.render()}
              </div>
              <p className="line-clamp-3 px-1 pb-1 text-xs text-muted-foreground">
                {selectedItem.preview.description}
              </p>
            </>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
