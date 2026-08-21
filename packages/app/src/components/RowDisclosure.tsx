/**
 * The "What changes?" disclosure shared by every setup row — the first-launch
 * consent rows and the create-project AI-tools row.
 *
 * A labelled button rather than a bare `i` glyph, and a click rather than a
 * hover. The overlay canon calls tooltips a last resort precisely because they
 * are "hidden by default, often with little visual indicator, and unavailable
 * on touch" — a named trigger fixes all three, and a text target clears the
 * 24x24 hit-target floor that a 14px icon did not.
 *
 * Focus is allowed to move into the panel (Radix's default). The stricter
 * toggletip pattern keeps focus on the trigger and announces through a live
 * region, but that relies on the region existing before its content does; here
 * the panel mounts already populated, so a screen reader can miss it entirely
 * and the button reads as broken. A dialog the user is moved into, and returns
 * from on Escape, is the more reliable shape — and it makes the panel
 * keyboard-scrollable, which matters because the dialog's scroll lock swallows
 * wheel events over anything portaled outside its own content.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function RowDisclosure({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          // Explicit type: some hosting rows sit inside a <form>, where a
          // typeless <button> defaults to submit and the disclosure would
          // fire the form instead of opening.
          type="button"
          variant="link-muted"
          size="sm"
          // Dotted underline rather than the usual solid link rule: it reads as
          // clickable without competing with the row's own text, and it stays put
          // instead of appearing on hover, which a pointer-less user never sees.
          // `decoration-dotted` needs an explicit `underline` to render at all.
          // Absolutely placed on the row's first line, so the description below
          // wraps the full width of the card instead of stopping short at a
          // column this button would otherwise reserve down the whole row. The
          // title span carries matching `pe-*` so long labels can't run under it.
          // Requires the row container to be `relative`.
          className="absolute end-3 top-2 px-1 text-1sm font-normal underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
          data-testid={testId}
        >
          <Trans comment="Button on each setup row that opens the list of files that row writes to">
            What changes?
          </Trans>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={title}
        // w-96 fits the longest skill destination on one line; the
        // available-width cap keeps it inside a narrow window, where a fixed
        // width would otherwise be placed past the viewport edge.
        className="max-h-(--radix-popover-content-available-height) w-96 max-w-(--radix-popover-content-available-width) overflow-y-auto p-3 subtle-scrollbar"
      >
        {/* A div, not a span: consumers pass flow content (the create-project
          row lists its files as a <ul>), which is invalid inside phrasing
          content. Layout is identical either way. */}
        <div className="flex flex-col gap-2 text-xs leading-normal">
          <span className="font-mono text-2xs text-muted-foreground uppercase tracking-wide">
            {title}
          </span>
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
