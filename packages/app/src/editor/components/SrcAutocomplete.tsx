/**
 * `SrcAutocomplete` — drop-in replacement for the bare `<Input>` in
 * `PropPanel`'s media-URL branch. Suggests existing workspace assets that
 * match the descriptor's `accept` MIME allowlist; selecting an item
 * inserts the asset's server-absolute path (`/<path>` — same shape
 * `PropUploadButton` emits) so the prop round-trips through
 * `validateMediaUrl` and renders byte-identically whether the user
 * typed, uploaded, or autocompleted.
 *
 * Open behavior:
 *   - Focus or click: opens with up to 8 suggestions in source order.
 *   - Typing: re-ranks via `searchWorkspaceCorpus` (BM25 + title boost +
 *     recency, intent `autocomplete`), matching the wiki-link suggestion
 *     menu's discovery contract.
 *   - Empty asset list: stays closed (no chrome flash when the workspace
 *     has no matching assets yet).
 *   - Blur / Escape / selection: closes. Click on item uses
 *     `onMouseDown` + `preventDefault` to keep DOM focus on the input
 *     (no flash, no scroll-jump).
 *
 * Keyboard contract — when popover is open:
 *   - ArrowDown / ArrowUp: cycle highlighted index.
 *   - Enter: insert highlighted suggestion; if none, do nothing (let the
 *     form keep whatever the user typed).
 *   - Escape: close the popover; don't bubble (so the parent dialog
 *     doesn't also close).
 *   - Tab: close and let the browser advance focus normally.
 *
 * The component owns popover open state, highlight state, and the search
 * corpus cache (fingerprint-keyed mirror of the wiki-link cache).
 * `value` / `onChange` flow through to the parent unchanged — the parent
 * still owns the canonical input value.
 */

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

/** Top-N cap on rendered suggestions — matches wiki-link suggestion's MAX_ITEMS. */
const MAX_ITEMS = 8;

/** Module-level shared instance to keep `assetPaths` referentially stable
 *  in the no-provider case (so the React Compiler can elide rerenders).
 */
const EMPTY_ASSET_SET: ReadonlySet<string> = new Set();

interface SrcAutocompleteProps {
  /** Current input value (server-absolute path or external URL). */
  value: string;
  /** Called with the new value on type OR on suggestion selection. */
  onChange: (value: string) => void;
  /** MIME accept allowlist from the descriptor; drives which assets surface. */
  accept: readonly string[];
  /** Forwarded `<input id>` — required so the sibling `<label>` clicks focus this input. */
  id: string;
  /** Optional placeholder forwarded to the underlying `<Input>`. */
  placeholder?: string;
  /** Forwarded `autoFocus` (PropPanel auto-focuses the first prop's input on open). */
  autoFocus?: boolean;
  /** Forwarded `aria-invalid` for validator-driven error chrome. */
  ariaInvalid?: boolean;
  /** Forwarded `aria-describedby` linking to the validator's `<p id=`${id}-error`>` sibling. */
  ariaDescribedBy?: string;
  /** Forwarded `data-prop-autofocus` (PropPanel uses this for restore-on-doc-change). */
  dataPropAutofocus?: string;
  /** Forwarded `className` so PropPanel keeps `h-7 text-sm`. */
  className?: string;
  /**
   * "Enter on the input with no highlighted suggestion" handler. PropPanel
   * passes its `onDismiss` here so the same Enter that confirms a
   * highlighted suggestion (existing contract) also dismisses the prop
   * popover when there's nothing to select. Without this, Enter is a
   * silent no-op for users who typed a fresh URL and pressed Enter to
   * acknowledge.
   */
  onSubmit?: () => void;
}

interface AssetItem {
  /** Path relative to contentDir, no leading slash (e.g. `assets/foo.png`). */
  path: string;
  /** Basename — shown as the primary label; matches the title used in search ranking. */
  basename: string;
}

interface AutocompleteCorpus {
  fingerprint: string;
  byPath: ReadonlyMap<string, AssetItem>;
  corpus: WorkspaceSearchCorpus;
  /** Source-order list — used to render the empty-query "top 8" view. */
  itemsInOrder: readonly AssetItem[];
}

/** Module-level corpus cache (mirrors wiki-link suggestion's pattern). */
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

/**
 * Strip a leading `/` for matching against asset paths (which are stored
 * without one) — the user may type `/assets/foo.png` after deletion-and-
 * retype, and we still want to rank against the matching corpus entry.
 */
function normalizeQueryForSearch(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  return trimmed;
}

/** Project the user's typed value to the ranked suggestion list. */
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
  // Use the optional variant — falls back to an empty asset list when no
  // PageListProvider is mounted (e.g. PropPanel's renderToString unit
  // tests, where mounting the real provider would trigger the page-list
  // fetch). The autocomplete just shows zero suggestions in that case;
  // the input stays usable.
  const pageList = useOptionalPageList();
  const assetPaths: ReadonlySet<string> = pageList?.assetPaths ?? EMPTY_ASSET_SET;

  // Plain const derivation — React Compiler memoizes; the module-level
  // `cachedCorpus` (fingerprint-keyed) is the actual cross-render reuse
  // for the BM25 index (which is expensive to rebuild and stable across
  // most renders). `filterAssetsByAccept` is O(assets) over a small set
  // and cheap to re-run unmemoized.
  const matchingPaths = filterAssetsByAccept(assetPaths, accept);
  const assetItems: readonly AssetItem[] = matchingPaths.map(makeAssetItem);
  const corpus = getCachedCorpus(assetItems);
  const suggestions = selectSuggestions(corpus, value);

  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Suggestions array shrinks as the user types — keep highlight in
  // bounds so an out-of-range index doesn't render the wrong row as
  // selected (or trip a key-event reading undefined).
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
    // Keep focus on the input so the user can keep editing without an
    // extra click. The popover closing already returned focus naturally,
    // but explicit refocus protects against the rare case where the
    // browser routed the mousedown focus elsewhere.
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
          // ARIA combobox role wiring — assistive tech announces the
          // popover as a listbox owned by this input, with the
          // highlighted item exposed via `aria-activedescendant`.
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
            // Re-open on every keystroke so users who clicked-then-typed
            // see updated rankings. Cheap — Popover dedups identical
            // open=true → open=true transitions.
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onClick={() => {
            // Click into an already-focused input should re-open the
            // popover (the user explicitly asked for it). Without this,
            // dismissing via Escape and re-clicking the same input
            // leaves the popover closed until the next keystroke.
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
                  // Block Enter from submitting the surrounding form /
                  // dispatching the property dialog's default action when an
                  // item is highlighted.
                  e.preventDefault();
                  selectSuggestion(item);
                  return;
                }
              }
              // No highlighted suggestion (popover closed, or open with an
              // empty suggestion set) — Enter is the form-submit signal.
              // Hand it to the parent PropPanel's dismiss so the user's
              // "I'm done typing" gesture closes the popover.
              if (onSubmit) {
                e.preventDefault();
                onSubmit();
              }
              return;
            }
            if (e.key === 'Escape') {
              if (!wantOpen) return;
              // Stop propagation so the parent prop panel / dialog doesn't
              // also interpret Escape as close-the-whole-thing.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              return;
            }
            if (e.key === 'Tab') {
              // Close on Tab; let the browser advance focus naturally.
              setOpen(false);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        // The popover anchors to an Input that's typically ~200-260px
        // wide; match that to avoid the dropdown ballooning to its
        // default 18rem and visually disconnecting from the input.
        //
        // `z-70` bumps above the PropPanel's own z-[60] PopoverContent
        // (see JsxComponentView.tsx) — without it the suggestion list
        // paints BEHIND the prop panel because both portal to body and
        // the default `z-50` on PopoverContent loses to the parent.
        // Matches `IconPickerInput`'s same fix for the same reason.
        //
        // `w-(--radix-popover-trigger-width)` is Tailwind v4's implicit-
        // var() syntax (parentheses). The v3 form `w-[--radix-popover-
        // trigger-width]` (square brackets) produces literal
        // `width: --radix-popover-trigger-width` in v4 — invalid CSS,
        // silently falls back to auto-width, and the dropdown balloons
        // to its longest suggestion (a workspace with deeply nested
        // asset paths renders a ~550px-wide list that overflows the
        // parent prop panel, swallows the upload affordance, and makes
        // the whole row read as broken).
        className="z-70 w-(--radix-popover-trigger-width) p-1"
        onOpenAutoFocus={(e) => {
          // Default Radix behavior moves focus into the PopoverContent
          // on open — that would yank focus off the input and visually
          // collapse the caret. We want the input to stay focused so
          // typing keeps working through the dropdown's lifetime.
          e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          // Same rationale on close — Radix would otherwise refocus the
          // trigger, but the trigger IS the input here (PopoverAnchor),
          // and we already manage focus in `selectSuggestion`. Leaving
          // this on causes a double-focus jolt on selection.
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          // Don't auto-close on outside-click of the input itself —
          // the input is the trigger but Radix sees it as "outside" the
          // popover content. We close on blur instead, which fires
          // naturally when focus actually leaves the input.
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
                  // Highlight follows keyboard nav (visual selection),
                  // separately from hover (mouse). Both styles match
                  // shadcn CommandItem's `data-[selected=true]` look.
                  isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  // Steal the mousedown — without preventDefault the
                  // browser fires `blur` on the input before our
                  // onClick handler runs, the popover closes, and the
                  // click lands on nothing. Same pattern PropPanel's
                  // `PropUploadButton` and the bubble-menu buttons use.
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
