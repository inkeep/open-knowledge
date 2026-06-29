import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
} from '@inkeep/open-knowledge-core';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { filterAssetsByAccept } from '../utils/filter-assets-by-accept';

const MAX_ITEMS = 8;

/** Module-level shared instance to keep `assetPaths` referentially stable
 *  in the no-provider case (so the React Compiler can elide rerenders).
 */
const EMPTY_ASSET_SET: ReadonlySet<string> = new Set();

interface SrcAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  accept: readonly string[];
  id: string;
  placeholder?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  dataPropAutofocus?: string;
  className?: string;
  onSubmit?: () => void;
}

interface AssetItem {
  path: string;
  basename: string;
}

interface AutocompleteCorpus {
  fingerprint: string;
  byPath: ReadonlyMap<string, AssetItem>;
  corpus: WorkspaceSearchCorpus;
  itemsInOrder: readonly AssetItem[];
}

let cachedCorpus: AutocompleteCorpus | null = null;

function makeAssetItem(path: string): AssetItem {
  const basename = path.split('/').pop() ?? path;
  return { path, basename };
}

function getCachedCorpus(items: readonly AssetItem[]): AutocompleteCorpus {
  const fingerprint = items.map((item) => item.path).join('');
  if (cachedCorpus?.fingerprint === fingerprint) return cachedCorpus;
  cachedCorpus = {
    fingerprint,
    byPath: new Map(items.map((item) => [item.path, item])),
    itemsInOrder: items,
    corpus: createWorkspaceSearchCorpus(
      items.map((item) =>
        createWorkspaceSearchDocument({
          kind: 'page',
          path: item.path,
          title: item.basename,
        }),
      ),
    ),
  };
  return cachedCorpus;
}

function normalizeQueryForSearch(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  return trimmed;
}

function selectSuggestions(corpus: AutocompleteCorpus, rawQuery: string): readonly AssetItem[] {
  const query = normalizeQueryForSearch(rawQuery);
  if (!query) return corpus.itemsInOrder.slice(0, MAX_ITEMS);
  return searchWorkspaceCorpus(corpus.corpus, query, {
    intent: 'autocomplete',
    limit: MAX_ITEMS,
  })
    .map((result) => corpus.byPath.get(result.document.path))
    .filter((item): item is AssetItem => Boolean(item));
}

export function SrcAutocomplete({
  value,
  onChange,
  accept,
  id,
  placeholder,
  autoFocus,
  ariaInvalid,
  ariaDescribedBy,
  dataPropAutofocus,
  className,
  onSubmit,
}: SrcAutocompleteProps): ReactNode {
  const pageList = useOptionalPageList();
  const assetPaths: ReadonlySet<string> = pageList?.assetPaths ?? EMPTY_ASSET_SET;

  const matchingPaths = filterAssetsByAccept(assetPaths, accept);
  const assetItems: readonly AssetItem[] = matchingPaths.map(makeAssetItem);
  const corpus = getCachedCorpus(assetItems);
  const suggestions = selectSuggestions(corpus, value);

  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (highlight >= suggestions.length) setHighlight(0);
  }, [highlight, suggestions.length]);

  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const wantOpen = open && suggestions.length > 0;

  const selectSuggestion = (item: AssetItem) => {
    onChange(`/${item.path}`);
    setOpen(false);
    setHighlight(0);
    inputRef.current?.focus();
  };

  return (
    <Popover open={wantOpen} onOpenChange={(next) => setOpen(next)}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          data-prop-autofocus={dataPropAutofocus}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={wantOpen}
          aria-controls={wantOpen ? listboxId : undefined}
          aria-activedescendant={
            wantOpen && suggestions[highlight] ? `${listboxId}-opt-${highlight}` : undefined
          }
          className={className}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onClick={() => {
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => (h + 1) % suggestions.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === 'Enter') {
              if (wantOpen) {
                const item = suggestions[highlight];
                if (item) {
                  e.preventDefault();
                  selectSuggestion(item);
                  return;
                }
              }
              if (onSubmit) {
                e.preventDefault();
                onSubmit();
              }
              return;
            }
            if (e.key === 'Escape') {
              if (!wantOpen) return;
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              return;
            }
            if (e.key === 'Tab') {
              setOpen(false);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="z-70 w-(--radix-popover-trigger-width) p-1"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          const target = e.target;
          if (target instanceof Node && inputRef.current?.contains(target)) {
            e.preventDefault();
          }
        }}
      >
        {/* Container is a `<div role="listbox">` rather than `<ul>` —
            the WAI-ARIA combobox pattern requires the popup referenced
            by the input's `aria-controls` to carry `role="listbox"` so
            assistive tech can resolve the combobox↔listbox ownership
            and the `aria-activedescendant` target; mirrors the
            companion `WikiLinkSuggestionMenu` + `link-path-suggestions`
            sites, which made the same `<ul>` → `<div role="listbox">`
            choice to satisfy biome's `noNoninteractiveElementToInteractiveRole`
            rule without suppression. The `<button role="option">`
            children stay — buttons accept the listbox-option role
            cleanly. */}
        <div
          id={listboxId}
          role="listbox"
          aria-label="Asset suggestions"
          className="flex flex-col gap-px"
        >
          {suggestions.map((item, idx) => {
            const optionId = `${listboxId}-opt-${idx}`;
            const isHighlighted = idx === highlight;
            return (
              <button
                key={item.path}
                id={optionId}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                data-testid="src-autocomplete-option"
                data-highlighted={isHighlighted ? '' : undefined}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1 text-left text-xs',
                  'transition-colors',
                  isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSuggestion(item);
                }}
              >
                <span className="font-medium">{item.basename}</span>
                {item.basename !== item.path && (
                  <span className="text-muted-foreground/70">{item.path}</span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
