import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { useLingui } from '@lingui/react/macro';
import {
  type ComponentProps,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { FileEntryIcon } from '@/components/file-entry-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  buildLinkPathSuggestions,
  isSlashPathSuggestionValue,
  type LinkPathSuggestion,
  type LinkPathSuggestionKind,
} from './link-path-suggestions-core';

export type { LinkPathSuggestion } from './link-path-suggestions-core';

const LINK_PATH_SUGGESTION_PANEL_SELECTOR = '[data-ok-link-path-suggestion-panel]';

export function isLinkPathSuggestionPanelTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(LINK_PATH_SUGGESTION_PANEL_SELECTOR) !== null;
}

export function preventLinkPathSuggestionDialogDismiss(event: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  if (isLinkPathSuggestionPanelTarget(event.target)) {
    event.preventDefault();
  }
}

function suggestionIcon(suggestion: LinkPathSuggestion) {
  switch (suggestion.kind) {
    case 'page':
      return <FileEntryIcon className="size-3.5" docExt=".md" kind="file" path={suggestion.path} />;
    case 'folder':
      return <FileEntryIcon className="size-3.5" kind="folder" path={suggestion.path} />;
    case 'asset':
      return (
        <FileEntryIcon
          bodyIndexed={false}
          className="size-3.5"
          kind="file"
          path={suggestion.path}
        />
      );
  }
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  ref.current = value;
}

type InputProps = Omit<
  ComponentProps<typeof Input>,
  | 'aria-activedescendant'
  | 'aria-autocomplete'
  | 'aria-controls'
  | 'aria-expanded'
  | 'onChange'
  | 'onKeyDown'
  | 'role'
  | 'value'
>;

interface LinkPathSuggestionInputProps extends InputProps {
  value: string;
  pages: ReadonlySet<string>;
  folderPaths?: ReadonlySet<string>;
  assetPaths?: ReadonlySet<string>;
  includeAssets?: boolean;
  loading?: boolean;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSuggestionSelect?: (suggestion: LinkPathSuggestion) => void;
}

export function LinkPathSuggestionInput({
  value,
  pages,
  folderPaths,
  assetPaths,
  includeAssets = false,
  loading = false,
  onValueChange,
  onKeyDown,
  onSuggestionSelect,
  onFocus,
  onBlur,
  className,
  ref,
  ...inputProps
}: LinkPathSuggestionInputProps & { ref?: Ref<HTMLInputElement> }) {
  const { t } = useLingui();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const emptyTriggered = value.trim() === '';
  const suggestionValue = emptyTriggered ? '/' : value;
  const suggestions = buildLinkPathSuggestions({
    value: suggestionValue,
    pages,
    folderPaths,
    assetPaths,
    includeAssets,
  });
  const suggestionsKey = suggestions
    .map((suggestion) => `${suggestion.kind}:${suggestion.path}`)
    .join('\u0000');
  const slashTriggered = isSlashPathSuggestionValue(value);
  const suggestionTriggered = emptyTriggered || slashTriggered;
  const showSuggestionOptions = suggestions.length > 0;
  const showSuggestions =
    focused && !dismissed && suggestionTriggered && (showSuggestionOptions || loading);
  const showNoMatches =
    focused && !dismissed && suggestionTriggered && !loading && !showSuggestionOptions;
  const showSuggestionPanel = showSuggestions || showNoMatches;
  const activeIndex = Math.min(highlightedIndex, Math.max(suggestions.length - 1, 0));
  const activeId = showSuggestionOptions ? `${listId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    void suggestionsKey;
    setHighlightedIndex(0);
  }, [suggestionsKey]);

  useEffect(() => {
    if (!showSuggestionPanel || !activeId) return;
    const activeOption = document.getElementById(activeId);
    activeOption?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, showSuggestionPanel]);

  useLayoutEffect(() => {
    if (!showSuggestionPanel) return;
    const reference = inputRef.current;
    const floating = panelRef.current;
    if (!reference || !floating) return;
    const referenceElement = reference;
    const floatingElement = floating;

    function updatePosition() {
      void computePosition(referenceElement, floatingElement, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(4),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, elements }) {
              Object.assign(elements.floating.style, {
                width: `${Math.min(480, availableWidth)}px`,
                maxHeight: `${Math.min(208, Math.max(96, availableHeight))}px`,
              });
            },
          }),
        ],
      })
        .then(({ x, y }) => {
          if (!floatingElement.isConnected) return;
          Object.assign(floatingElement.style, {
            left: `${x}px`,
            top: `${y}px`,
          });
        })
        .catch((err) => {
          if (floatingElement.isConnected) {
            console.warn('[LinkPathSuggestionInput] computePosition failed', err);
          }
        });
    }

    const stop = autoUpdate(referenceElement, floatingElement, updatePosition);
    updatePosition();
    return stop;
  }, [showSuggestionPanel]);

  function setInputRef(node: HTMLInputElement | null) {
    inputRef.current = node;
    assignRef(ref, node);
  }

  function selectSuggestion(suggestion: LinkPathSuggestion) {
    if (onSuggestionSelect) {
      onSuggestionSelect(suggestion);
    } else {
      onValueChange(suggestion.path);
    }
    setDismissed(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (showSuggestionOptions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((current) => Math.min(current + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const active = suggestions[activeIndex];
        if (active) selectSuggestion(active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // First Escape dismisses autocomplete; the parent dialog/popover gets
        // the next Escape if the user wants to close the whole surface.
        setDismissed(true);
        return;
      }
    }
    if (showSuggestionPanel && event.key === 'Escape') {
      event.preventDefault();
      // See matching-options Escape branch.
      setDismissed(true);
      return;
    }
    onKeyDown?.(event);
  }

  function labelForKind(kind: LinkPathSuggestionKind): string {
    switch (kind) {
      case 'page':
        return t`Page`;
      case 'folder':
        return t`Folder`;
      case 'asset':
        return t`Asset`;
    }
  }

  const suggestionPanel = showSuggestionPanel ? (
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      aria-label={t`Path suggestions`}
      data-ok-layer-spawned=""
      data-ok-link-path-suggestion-panel=""
      className="fixed z-70 max-h-52 overflow-y-auto overscroll-y-contain rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md subtle-scrollbar pointer-events-auto"
      onWheel={(event) => {
        event.stopPropagation();
      }}
      onTouchMove={(event) => {
        event.stopPropagation();
      }}
    >
      {showSuggestionOptions ? (
        suggestions.map((suggestion, index) => {
          const selected = index === activeIndex;
          const kindLabel = labelForKind(suggestion.kind);
          return (
            <Button
              key={`${suggestion.kind}:${suggestion.path}`}
              id={`${listId}-option-${index}`}
              type="button"
              role="option"
              aria-label={`/${suggestion.path} ${kindLabel}`}
              aria-selected={selected}
              variant="ghost"
              className={cn(
                'h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left font-normal',
                selected && 'bg-accent text-accent-foreground',
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(suggestion)}
            >
              {suggestionIcon(suggestion)}
              <span className="min-w-0 flex-1 truncate">/{suggestion.path}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{kindLabel}</span>
            </Button>
          );
        })
      ) : (
        <div role="status" className="px-2 py-1.5 text-muted-foreground text-sm">
          {loading ? t`Loading paths…` : t`No matching paths`}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="relative">
      <Input
        {...inputProps}
        ref={setInputRef}
        value={value}
        onChange={(event) => {
          setDismissed(false);
          onValueChange(event.target.value);
        }}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showSuggestionPanel}
        aria-controls={showSuggestionPanel ? listId : undefined}
        aria-activedescendant={activeId}
        autoComplete="off"
        className={className}
      />
      {/* Manual portal + Floating UI keeps the listbox out of clipped dialog
      bodies and avoids nested Radix Popover focus management in prop panels. */}
      {suggestionPanel && createPortal(suggestionPanel, document.body)}
    </div>
  );
}
