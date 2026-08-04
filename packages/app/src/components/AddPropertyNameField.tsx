/**
 * The add-property row's name field: a free-text input that also offers the
 * fields the doc's governing schemas declare.
 *
 * Adding a schema-governed property otherwise means leaving the doc to read the
 * schema, coming back, retyping the name, and hand-picking a type the schema
 * already states. Picking a suggestion fills both.
 *
 * Free text is preserved rather than replaced by a select: schemas do not own
 * the whole vocabulary (`additionalProperties` is open by default, and most
 * docs are governed by no schema at all). With no suggestions to offer this is
 * exactly the plain input it replaced — the popup never mounts.
 *
 * Shape is the ARIA 1.2 combobox-with-listbox-popup pattern, hand-driven rather
 * than delegated to `cmdk`: focus has to stay in the input for typing to work,
 * and cmdk listens for keys on its own root, so its navigation never sees them.
 * The popup is a Radix popover because the properties disclosure clips
 * overflow — an in-flow dropdown would be cut off.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { type KeyboardEvent, type RefObject, useId, useState } from 'react';
import { TYPE_ICON } from '@/components/PropertyWidgets';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { SchemaField } from '@/lib/frontmatter-schema-fields';

/**
 * One schema-declared field the picker can offer — a `SchemaField` plus the name
 * it is declared under. Derived rather than redeclared: the host builds these by
 * spreading a `SchemaField`, so a member added there should reach the picker
 * without anyone remembering to widen this too.
 */
export interface AddPropertyFieldSuggestion extends SchemaField {
  name: string;
}

/** Case-insensitive substring match on the field name. */
function matches(suggestion: AddPropertyFieldSuggestion, query: string): boolean {
  if (query === '') return true;
  return suggestion.name.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * The list is up but the user has not moved into it, so nothing is highlighted.
 *
 * Without a state for this, an open list always has an active option and Enter
 * always takes it — which substitutes a schema field for any name that merely
 * contains one (`tag` becomes `tags`), overwriting the drafted type along with
 * the name. Matches the ARIA APG editable combobox: opening does not select, and
 * Enter adopts an option only once the user has arrowed or hovered onto it.
 */
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
  /** Scopes this field's DOM ids so sibling add-rows can't collide. */
  rowId: string;
  value: string;
  /** Offerable fields — the host excludes the ones the doc already has. */
  suggestions: readonly AddPropertyFieldSuggestion[];
  inputRef: RefObject<HTMLInputElement | null>;
  autoFocus: boolean;
  error: boolean;
  errorId?: string;
  onChange: (next: string) => void;
  /** Picking sets the name AND the schema's type in one update. */
  onPick: (suggestion: AddPropertyFieldSuggestion) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const baseId = useId();
  const listboxId = `${baseId}-fields`;
  // A row that mounts already focused starts with its list up. `autoFocus` is a
  // mount-time attribute, so no `focus` event ever fires for it — waiting on
  // one would hide the schema's fields behind a keystroke the user has no
  // reason to guess, which is most of what the picker is for.
  const [open, setOpen] = useState(() => autoFocus && suggestions.length > 0);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);

  const filtered = suggestions.filter((suggestion) => matches(suggestion, value));
  // An exact hit is the field the user already typed out; keeping the popup up
  // would just offer them what they have and swallow the Enter that commits it.
  const exactlyTyped = filtered.some((s) => s.name === value.trim());
  const isOpen = open && filtered.length > 0 && !exactlyTyped;

  // Typing narrows the list, so a held index would leave the highlight on
  // whatever field happens to sit at that position afterwards. Each keystroke
  // is also a fresh statement of intent, so it drops the user back out of the
  // list and Enter goes back to committing what they typed. Adjusted during
  // render (React's documented reset-on-prop-change pattern) instead of in an
  // effect, which would paint the stale highlight for a frame first.
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
      // Nothing to navigate — including when an exact match holds the list shut,
      // which leaves the filter non-empty. Claiming the key here would swallow
      // its caret movement to open a list that cannot open.
      if (filtered.length === 0 || exactlyTyped) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // Entering the list — from closed, or from open-but-unselected — lands on
      // the end the user reached toward, rather than stepping off a phantom
      // position before the first option.
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
      // Focus stays in the input, so the browser won't scroll the
      // `aria-activedescendant` target into view the way it does a focused
      // element — on the `max-h-64` popup the highlighted option can slip below
      // the fold. Scroll it in by hand, per the ARIA APG combobox pattern. `?.`
      // covers jsdom, which stubs `scrollIntoView`. The option elements already
      // exist this render (only the highlight class changes), so no rAF needed.
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
      // Enter takes a suggestion only once the user has moved onto it. An open
      // list on its own does not claim the key — the name field is free text,
      // so a name the schema merely resembles still commits as typed.
      if (active) {
        pick(active);
        return;
      }
      // Committing dismisses the list either way, per the APG textbox contract.
      // Reachable with the list still up now that an open list no longer claims
      // Enter, so a row the host declines to commit must not be left sitting
      // under a popup the user already answered.
      setOpen(false);
      onCommit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape dismisses the popup first; a second press abandons the row.
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
          // Opening on focus is the discovery half: a user who does not know
          // the schema declares anything sees the list without typing. Guarded
          // so a field with nothing to offer never re-renders for it.
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
        // The input is the typing surface; the popup must never take focus off
        // it, or the next keystroke lands nowhere. Radix would also send focus
        // back on close, fighting the type-picker's own refocus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The input is an anchor, which lives OUTSIDE the content — so Radix
        // counts a click on it as an outside interaction and closes the list.
        // For a type-ahead that is backwards: clicking into the field, or
        // clicking to reposition the caret, must not dismiss what you are
        // choosing from. (Only reproducible in a real browser; jsdom does not
        // fire Radix's outside-pointer detection.)
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (target instanceof Node && inputRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
        className="w-64 max-h-64 overflow-y-auto p-1"
      >
        {/* Visual section label only — the listbox below carries the same text
            as its `aria-label`, so leaving this exposed announces it twice. */}
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
                // Commit on mousedown: a click would blur the input first, and
                // the blur closes the popup out from under the pointer.
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
                  <Badge variant="gray" className="ml-auto shrink-0 text-2xs">
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
