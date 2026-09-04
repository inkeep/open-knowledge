import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { SlashCommandItem } from './composer-slash-command';

interface ComposerSlashMenuProps {
  items: SlashCommandItem[];
  query: string;
  selectedIndex: number;
  onSelect: (item: SlashCommandItem) => void;
  commandsKnown: boolean;
}

export function ComposerSlashMenu({
  items,
  query,
  selectedIndex,
  onSelect,
  commandsKnown,
}: ComposerSlashMenuProps) {
  const { t } = useLingui();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const options = containerRef.current?.querySelectorAll('[role="option"]');
    options?.item(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectedItem =
    selectedIndex >= 0 && selectedIndex < items.length ? items[selectedIndex] : null;

  return (
    <div
      ref={containerRef}
      data-testid="composer-slash-menu"
      className="w-[42rem] max-w-[min(42rem,90vw)] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
          {!commandsKnown
            ? t`This agent hasn't announced its commands yet`
            : query.trim() === ''
              ? t`This agent doesn't offer slash commands`
              : t`No matching commands`}
        </p>
      ) : (
        <div
          role="listbox"
          id={listboxId}
          aria-label={t`Slash command suggestions`}
          tabIndex={-1}
          className="max-h-64 overflow-y-auto overscroll-contain subtle-scrollbar"
        >
          {}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {selectedItem ? `/${selectedItem.name}` : ''}
          </span>
          {items.map((item, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={item.name}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active}
                data-testid={`composer-slash-option-${item.name}`}
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left ${
                  active ? 'bg-accent text-accent-foreground' : ''
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item);
                }}
              >
                <span className="shrink-0 font-mono text-sm font-medium">/{item.name}</span>
                <span className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">
                  {item.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
