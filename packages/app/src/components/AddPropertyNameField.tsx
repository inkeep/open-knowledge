import { Trans, useLingui } from '@lingui/react/macro';
import { type KeyboardEvent, type RefObject, useId, useState } from 'react';
import { TYPE_ICON } from '@/components/PropertyWidgets';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { SchemaField } from '@/lib/frontmatter-schema-fields';

export interface AddPropertyFieldSuggestion extends SchemaField {
  name: string;
}

function matches(suggestion: AddPropertyFieldSuggestion, query: string): boolean {
  if (query === '') return true;
  return suggestion.name.toLowerCase().includes(query.trim().toLowerCase());
}

const NO_HIGHLIGHT = -1;

export function AddPropertyNameField({
  rowId,
  value,
  suggestions,
  inputRef,
  autoFocus,
  error,
  errorId,
  onChange,
  onPick,
  onCommit,
  onCancel,
}: {
  rowId: string;
  value: string;
  suggestions: readonly AddPropertyFieldSuggestion[];
  inputRef: RefObject<HTMLInputElement | null>;
  autoFocus: boolean;
  error: boolean;
  errorId?: string;
  onChange: (next: string) => void;
  onPick: (suggestion: AddPropertyFieldSuggestion) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const baseId = useId();
  const listboxId = `${baseId}-fields`;
  const [open, setOpen] = useState(() => autoFocus && suggestions.length > 0);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);

  const filtered = suggestions.filter((suggestion) => matches(suggestion, value));
  const exactlyTyped = filtered.some((s) => s.name === value.trim());
  const isOpen = open && filtered.length > 0 && !exactlyTyped;

  const [queryAtLastReset, setQueryAtLastReset] = useState(value);
  if (value !== queryAtLastReset) {
    setQueryAtLastReset(value);
    setHighlight(NO_HIGHLIGHT);
  }

  const active =
    isOpen && highlight !== NO_HIGHLIGHT
      ? filtered[Math.min(highlight, filtered.length - 1)]
      : undefined;

  function pick(suggestion: AddPropertyFieldSuggestion): void {
    onPick(suggestion);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (filtered.length === 0 || exactlyTyped) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const entryIndex = delta === 1 ? 0 : filtered.length - 1;
      if (!isOpen) {
        setOpen(true);
        setHighlight(entryIndex);
        return;
      }
      const nextIndex =
        highlight === NO_HIGHLIGHT
          ? entryIndex
          : (highlight + delta + filtered.length) % filtered.length;
      setHighlight(nextIndex);
      const next = filtered[nextIndex];
      if (next) {
        document
          .getElementById(`${listboxId}-${next.name}`)
          ?.scrollIntoView?.({ block: 'nearest' });
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) {
        pick(active);
        return;
      }
      setOpen(false);
      onCommit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (isOpen) setOpen(false);
      else onCancel();
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          data-testid="add-property-name-input"
          data-key={rowId}
          type="text"
          value={value}
          autoFocus={autoFocus}
          placeholder={t`Property name`}
          aria-label={t`New property name`}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          role={suggestions.length > 0 ? 'combobox' : undefined}
          aria-expanded={suggestions.length > 0 ? isOpen : undefined}
          aria-controls={isOpen ? listboxId : undefined}
          aria-autocomplete={suggestions.length > 0 ? 'list' : undefined}
          aria-activedescendant={active ? `${listboxId}-${active.name}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            if (suggestions.length > 0) setOpen(true);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="h-7 w-32 border-transparent bg-transparent px-2 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0 rounded-sm @max-[26rem]/prow:w-auto @max-[26rem]/prow:flex-1"
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={2}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (target instanceof Node && inputRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
        className="w-64 max-h-64 overflow-y-auto p-1"
      >
        {}
        <div
          aria-hidden
          className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide"
        >
          <Trans>Schema fields</Trans>
        </div>
        <div id={listboxId} role="listbox" aria-label={t`Schema fields`}>
          {filtered.map((suggestion, index) => {
            const Icon = TYPE_ICON[suggestion.type];
            const isActive = suggestion.name === active?.name;
            return (
              // biome-ignore lint/a11y/useFocusableInteractive: options in this pattern are deliberately not focusable — focus stays in the input and `aria-activedescendant` conveys the selection. Keyboard access runs through the input's own handler.
              <div
                key={suggestion.name}
                id={`${listboxId}-${suggestion.name}`}
                role="option"
                aria-selected={isActive}
                data-testid="add-property-field-suggestion"
                data-key={suggestion.name}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(suggestion);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${
                  isActive ? 'bg-accent text-accent-foreground' : ''
                }`}
              >
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{suggestion.name}</span>
                  {suggestion.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {suggestion.description}
                    </span>
                  ) : null}
                </span>
                {suggestion.required ? (
                  <Badge variant="gray" className="ms-auto shrink-0 text-2xs">
                    <Trans>required</Trans>
                  </Badge>
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
