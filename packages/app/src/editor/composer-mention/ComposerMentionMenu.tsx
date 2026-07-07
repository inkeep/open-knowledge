/**
 * Typeahead menu for the bottom composer's `@`-mention input. A thin, page-only
 * sibling of `WikiLinkSuggestionMenu` — no anchors, no asset/create modes — so
 * the composer surfaces a clean "reference an existing doc" list. Driven by the
 * `@tiptap/suggestion` render lifecycle in `composer-mention.ts`; the menu is a
 * pure render of the current items + selection.
 */
import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import { FileEntryPathIcon } from '@/components/file-entry-icon';
import { mentionPathToDescriptor } from '../registry/file-icons';
import type { MentionItem } from './composer-mention';

/**
 * Classify a mention row from its serialized `path` for the row's affordances
 * (the `data-mention-kind` marker + the folder trailing-slash). Derives via the
 * shared {@link mentionPathToDescriptor} so the row's folder/page/asset label
 * agrees with the file-entry icon path. `'document'` collapses to `'page'` here
 * — a mention path only ever yields folder/page/asset.
 */
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
  /** True when the first fetch rejected — render a retry hint instead of the
   *  silent "no docs" empty state, so a failed load doesn't read as an empty
   *  corpus. The extension retries on the next `@`. */
  error?: boolean;
  /** True when the list was capped — a passive "keep typing to narrow" hint. */
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

  // Keep the active option scrolled into view as the user arrows through. Index
  // the option list by selectedIndex (rather than a data-attr query) so the
  // effect genuinely depends on it and re-fires on every move.
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
        // Distinct from the empty state: a failed fetch reads as broken, not
        // empty. The extension re-fetches on the next `@`, so tell the user.
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
          className="max-h-64 overflow-y-auto subtle-scrollbar"
        >
          {/*
            Live region announces the selected item on arrow navigation.
            Required because aria-activedescendant on the listbox is inert here —
            focus stays in ProseMirror's contentEditable, and screen readers only
            announce activedescendant on the focused element.
          */}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {selectedItem ? selectedItem.title : ''}
          </span>
          {items.map((item, index) => {
            const active = index === selectedIndex;
            const kind = mentionItemKind(item.path);
            const isFolder = kind === 'folder';
            // Folders read clearer with a trailing slash — the same affordance
            // file managers use to signal "this is a container, not a leaf".
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
                // Insert on mousedown rather than click so the editor never
                // loses focus to the menu button before the chip lands.
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
                  {/* Wrap (break-all + clamp) rather than end-truncate so the
                      discriminating tail of a long path stays visible — the
                      wider popup gives it room. */}
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
