/**
 * Typeahead menu for the composer's `/` slash-command picker — the command
 * sibling of `ComposerMentionMenu`, driven by the same `@tiptap/suggestion`
 * render lifecycle (in `composer-slash-command.ts`); the menu is a pure render
 * of the current items + selection.
 *
 * The two empty states are deliberately distinct: an agent that hasn't
 * advertised yet gets neutral "not yet known" copy, an agent that advertised
 * zero commands gets an honest "doesn't offer" — the picker must never imply
 * support that isn't there.
 */
import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { SlashCommandItem } from './composer-slash-command';

interface ComposerSlashMenuProps {
  items: SlashCommandItem[];
  query: string;
  selectedIndex: number;
  onSelect: (item: SlashCommandItem) => void;
  /** False while the agent hasn't advertised a command list yet (`null`
   *  corpus) — "not yet known" renders differently than "advertised none". */
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

  // Keep the active option scrolled into view as the user arrows through.
  useEffect(() => {
    const options = containerRef.current?.querySelectorAll('[role="option"]');
    options?.item(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectedItem =
    selectedIndex >= 0 && selectedIndex < items.length ? items[selectedIndex] : null;

  return (
    // Much wider than the `@`-mention menu on purpose: command rows pair a
    // long mono name with a sentence-length description, and at narrow
    // widths most rows wrap to three lines. The only hard ceiling is the
    // viewport (the min() keeps narrow windows safe).
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
          {/*
            Live region announces the selected item on arrow navigation.
            Required because aria-activedescendant on the listbox is inert here —
            focus stays in ProseMirror's contentEditable, and screen readers only
            announce activedescendant on the focused element.
          */}
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
                // Insert on mousedown rather than click so the editor never
                // loses focus to the menu button before the text lands.
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
