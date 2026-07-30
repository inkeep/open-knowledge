/**
 * The composer's `+` — add context to this message.
 *
 * For composers with NO context-chip row. Where a row exists (the Ask AI
 * composer), the chip itself is the toggle: it already has to render to say a
 * queue exists, so a second control behind a menu was one click deep, invisible
 * until opened, and a duplicate of the ✕ it sat above. An agent thread's
 * composer is a plain text field with nowhere to put a chip, which is what this
 * menu is for.
 *
 * Opened as a menu rather than a bare button because context sources will grow
 * past the comment queue, and a row of one button per possible source stops
 * being a summary of what IS attached.
 *
 * Attaching is deliberately NOT sending: the item puts the batch on the message
 * so the composer's own send carries it.
 *
 * The row is a toggle. It once had a second, action-only variant for a host
 * that could not undo the add; nothing ever rendered it, so it is gone rather
 * than kept warm for a caller that may never arrive.
 */

import { Plural, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export function ComposerAddContextMenu({
  queueCount,
  queueAttached,
  compact = false,
  onAddQueue,
  onRemoveQueue,
}: {
  /** Comments waiting in the dispatch queue, attached or not. `0` → the row is disabled. */
  queueCount: number;
  /** The queue is riding this message — the toggle's state. */
  queueAttached: boolean;
  /** Take the queue back off this message. */
  onRemoveQueue: () => void;
  /**
   * Size the trigger for a dense action bar rather than a composer row.
   *
   * The agent thread's bar is a row of `h-6` / `text-xs` controls (the settings
   * trigger beside this one); the Ask AI composer's row is sized to a
   * full-height input and its send button. One fixed size cannot sit right in
   * both, so the host says which bar it is — rather than the control guessing
   * from context or every caller passing raw classes.
   */
  compact?: boolean;
  onAddQueue: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          // No `size` in compact mode: the height and padding come from the
          // classes below, matching the settings trigger exactly.
          {...(compact ? {} : { size: 'icon' as const })}
          variant="ghost"
          aria-label={t`Add context to this message`}
          data-testid="composer-add-context"
          // `shrink-0` either way, so the row's layout is identical whether or
          // not anything is attached — the input keeps every remaining pixel.
          className={cn(
            'shrink-0 text-muted-foreground hover:text-foreground',
            compact ? 'h-6 rounded-md px-2' : 'size-8',
          )}
        >
          <Plus className={compact ? 'size-3.5' : 'size-4'} />
        </Button>
      </DropdownMenuTrigger>
      {/* `align="start"` so the menu grows from the `+` rather than the far side
          of the composer, and `side="top"` because the composer is docked at the
          bottom of the column — a downward menu would open off-screen.
          The width override is required, not cosmetic: DropdownMenuContent
          sizes itself to `--radix-dropdown-menu-trigger-width` with a `min-w-32`
          floor, which is 8rem against a 2rem icon trigger — narrow enough to
          wrap a row like "Queue (5 comments)" onto two lines. `w-60` is the
          agent-settings menu's width, so the two menus in that action bar are
          the same size rather than nearly. */}
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-60"
        data-testid="composer-add-context-menu"
      >
        {/* An empty queue leaves the row visible but inert: hiding it would make
            the menu look broken to someone who opened it specifically to add
            comments, and the secondary line says why.

            The agent-settings menu's own on/off row shape (`Fast mode`): a real
            `menuitemcheckbox` owns the state, its default checkmark is hidden,
            and a decorative Switch stands in on the right. The Switch is
            aria-hidden + pointer-events-none so it never becomes a second,
            invalid menu control. */}
        <DropdownMenuCheckboxItem
          checked={queueCount > 0 && queueAttached}
          onCheckedChange={(next) => (next ? onAddQueue() : onRemoveQueue())}
          disabled={queueCount === 0}
          // Keep the menu open on toggle, matching the settings menu — you can
          // see the chip row change behind it without reopening.
          onSelect={(event) => event.preventDefault()}
          className="items-start justify-between gap-4 pr-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
          data-testid="composer-add-context-queue"
        >
          <div className="flex min-w-0 flex-col">
            <span>{t`Queue`}</span>
            <span className="text-1sm text-muted-foreground">
              {queueCount === 0 ? (
                t`Nothing queued`
              ) : (
                <Plural value={queueCount} one="# comment" other="# comments" />
              )}
            </span>
          </div>
          <Switch
            checked={queueCount > 0 && queueAttached}
            size="sm"
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none mt-0.5"
          />
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
