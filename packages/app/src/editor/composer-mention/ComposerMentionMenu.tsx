import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import { FileEntryPathIcon } from '@/components/file-entry-icon';
import { mentionPathToDescriptor } from '../registry/file-icons';
import type { MentionItem } from './composer-mention';

function mentionItemKind(path: string): 'folder' | 'page' | 'asset' {
  const kind = mentionPathToDescriptor(path).kind;
  return kind === 'folder' || kind === 'asset' ? kind : 'page';
}

interface ComposerMentionMenuProps {
  items: MentionItem[];
  query: string;
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  loading?: boolean;
  error?: boolean;
  hasMore?: boolean;
}

export function ComposerMentionMenu({
  items,
  query,
  selectedIndex,
  onSelect,
  loading = false,
  error = false,
  hasMore = false,
}: ComposerMentionMenuProps) {
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
      className="w-80 max-w-[min(28rem,90vw)] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {loading ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
          {t`Searching docs`}
        </p>
      ) : error ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="assertive">
          {t`Couldn't load docs — type @ again to retry`}
        </p>
      ) : items.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
          {query.trim() === '' ? t`Type to find a doc` : t`No matching docs`}
        </p>
      ) : (
        <div
          role="listbox"
          id={listboxId}
          aria-label={t`Doc mention suggestions`}
          tabIndex={-1}
          className="max-h-64 overflow-y-auto overscroll-contain subtle-scrollbar"
        >
          {}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {selectedItem ? selectedItem.title : ''}
          </span>
          {items.map((item, index) => {
            const active = index === selectedIndex;
            const kind = mentionItemKind(item.path);
            const isFolder = kind === 'folder';
            const displayPath = isFolder ? `${item.path}/` : item.path;
            return (
              <button
                key={item.docName}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active}
                data-mention-kind={kind}
                data-testid={`composer-mention-option-${item.docName}`}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                  active ? 'bg-accent text-accent-foreground' : ''
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item);
                }}
              >
                <FileEntryPathIcon
                  path={item.path}
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {isFolder ? (
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t`Folder`}
                      </span>
                    ) : null}
                  </span>
                  {}
                  <span className="line-clamp-2 break-all text-xs text-muted-foreground">
                    {displayPath}
                  </span>
                </span>
              </button>
            );
          })}
          {hasMore ? (
            <div className="px-2 py-1 text-xs text-muted-foreground" aria-hidden>
              {t`Showing top matches — keep typing to narrow`}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
