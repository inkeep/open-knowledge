import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { isImeCompositionKey } from '@/lib/ime-composition';
import { cn } from '@/lib/utils';

export interface Suggestion {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

interface SuggestionInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly Suggestion[];
  listLabel: string;
  emptyMessage?: string;
  placeholder?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  dataPropAutofocus?: string;
  className?: string;
  onSubmit?: () => void;
}

export type SuggestionFieldProps = Omit<
  SuggestionInputProps,
  'suggestions' | 'listLabel' | 'emptyMessage'
>;

export function SuggestionInput({
  id,
  value,
  onChange,
  suggestions,
  listLabel,
  emptyMessage,
  placeholder,
  autoFocus,
  ariaInvalid,
  ariaDescribedBy,
  dataPropAutofocus,
  className,
  onSubmit,
}: SuggestionInputProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (highlight >= suggestions.length) setHighlight(0);
  }, [highlight, suggestions.length]);

  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const listOpen = open && suggestions.length > 0;
  const showEmptyMessage = open && suggestions.length === 0 && emptyMessage !== undefined;

  const selectSuggestion = (item: Suggestion) => {
    onChange(item.value);
    setOpen(false);
    setHighlight(0);
    inputRef.current?.focus();
  };

  return (
    <>
      <Popover open={listOpen || showEmptyMessage} onOpenChange={(next) => setOpen(next)}>
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
            aria-expanded={listOpen}
            aria-controls={listOpen ? listboxId : undefined}
            aria-activedescendant={
              listOpen && suggestions[highlight] ? `${listboxId}-opt-${highlight}` : undefined
            }
            className={className}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
              setHighlight(0);
            }}
            onClick={() => {
              setOpen(true);
            }}
            onBlur={() => {
              setOpen(false);
            }}
            onKeyDown={(e) => {
              if (isImeCompositionKey(e)) return;
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
                if (listOpen) {
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
                if (!listOpen && !showEmptyMessage) return;
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
          data-ok-declines-keyboard=""
          onMouseDown={(e) => {
            e.preventDefault();
          }}
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
          {suggestions.length === 0 ? (
            emptyMessage !== undefined && (
              <p className="px-2 py-1 text-xs text-muted-foreground wrap-break-word">
                {emptyMessage}
              </p>
            )
          ) : (
            <div
              id={listboxId}
              role="listbox"
              aria-label={listLabel}
              className="flex flex-col gap-px"
            >
              {suggestions.map((item, idx) => {
                const optionId = `${listboxId}-opt-${idx}`;
                const isHighlighted = idx === highlight;
                return (
                  <button
                    key={item.value}
                    id={optionId}
                    type="button"
                    role="option"
                    aria-selected={isHighlighted}
                    data-testid="suggestion-option"
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
                    <span className="font-medium">{item.label}</span>
                    {item.detail !== undefined && (
                      <span
                        className={
                          isHighlighted ? 'text-accent-foreground/70' : 'text-muted-foreground'
                        }
                      >
                        {item.detail}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <span role="status" aria-live="polite" className="sr-only">
        {showEmptyMessage ? emptyMessage : ''}
      </span>
    </>
  );
}
