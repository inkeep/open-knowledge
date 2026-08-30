/**
 * Shared icon-only CopyButton.
 *
 * Ghost button that writes `copyContent` to the clipboard. On success the
 * icon swaps to a Check for `COPIED_RESET_MS` (the familiar "Copied!"
 * affordance), then reverts to Copy. Permission denials / insecure-context
 * failures are silent — the icon stays as Copy without throwing.
 *
 * Reused by the link PropPanels (`LinkPropPanelCopy` re-exports this) and the
 * ShareButton popover. The clipboard path is injectable so the share surface
 * can route through `scheduleClipboardWrite` (Electron IPC bridge) while the
 * PropPanels keep the default `navigator.clipboard` path.
 */

import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const COPIED_RESET_MS = 1500;

async function defaultClipboardWrite(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('clipboard unavailable');
  }
  await navigator.clipboard.writeText(text);
}

export interface CopyButtonProps {
  copyContent: string;
  /**
   * Clipboard writer; defaults to `navigator.clipboard.writeText`. The share
   * surface injects `scheduleClipboardWrite` so the in-popover copy prefers
   * the Electron IPC bridge, matching the auto-copy path.
   */
  clipboardWrite?: (text: string) => Promise<void>;
  /**
   * Mount already in the copied (check) state — for when `copyContent` was
   * auto-copied before this button rendered (e.g. the ShareButton popover
   * opens right after the click-time copy). Reverts to Copy after the
   * standard reset window.
   */
  initialCopied?: boolean;
  /** Button size, for hosts whose row is tighter than the default. Narrowed to
   *  the icon sizes because this renders a bare glyph with no label, and taken
   *  from `Button` so a renamed variant stops compiling here too. */
  size?: Extract<React.ComponentProps<typeof Button>['size'], 'icon-xs' | 'icon-sm'>;
  /**
   * Accessible name in the idle state, when "Copy" alone is ambiguous — a
   * transcript full of copyable things needs to say WHICH one. The copied
   * state keeps the shared "Copied!" either way.
   */
  ariaLabel?: string;
  testId?: string;
}

export function CopyButton({
  copyContent,
  clipboardWrite = defaultClipboardWrite,
  initialCopied = false,
  size = 'icon-sm',
  ariaLabel,
  testId,
}: CopyButtonProps) {
  const { t } = useLingui();
  // A monotonic tick rather than a boolean so a re-click while already
  // "copied" restarts the reset timer (the effect re-runs on every bump).
  const [copyTick, setCopyTick] = useState(initialCopied ? 1 : 0);
  const copied = copyTick > 0;

  useEffect(() => {
    if (copyTick === 0) return;
    const id = setTimeout(() => setCopyTick(0), COPIED_RESET_MS);
    return () => clearTimeout(id);
  }, [copyTick]);

  const handleClick = () => {
    // Promise.resolve() wrapper catches both a synchronous throw and an
    // async rejection from the injected writer.
    Promise.resolve()
      .then(() => clipboardWrite(copyContent))
      .then(
        () => setCopyTick((n) => n + 1),
        () => {
          /* permission denial / insecure context — leave icon as Copy */
        },
      );
  };

  const buttonLabel = copied ? t`Copied!` : (ariaLabel ?? t`Copy`);

  return (
    // The content only echoes the button's accessible name, so keeping it
    // hoverable buys nothing and its grace polygon costs: with the content
    // flush to the trigger, the polygon covers a neighboring button's near
    // edge, holding this tooltip open there and suppressing the neighbor's
    // from opening. Convention note: ui/tooltip.tsx.
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant="ghost"
          aria-label={buttonLabel}
          onClick={handleClick}
          data-testid={testId}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{buttonLabel}</TooltipContent>
    </Tooltip>
  );
}
