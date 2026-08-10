import { Progress as ProgressPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Horizontal progress bar, determinate or indeterminate.
 *
 * Installed from shadcn/ui with three deliberate divergences, recorded so a
 * future `shadcn diff` reviewer knows the drift is intentional rather than rot:
 *
 *  1. `value` is forwarded to the Radix root. Upstream destructures it and uses
 *     it only to compute the indicator transform, so the root never sees a value
 *     and every bar reports as indeterminate — the visual fills while the
 *     accessible `aria-valuenow` stays absent. Forwarding is what makes a
 *     determinate bar actually announce its position.
 *  2. `indeterminateFillPercent` paints the track while `value` stays null.
 *     Radix renders `value={null}` as an empty bar, but some progress is honestly
 *     unknowable (no byte counts cross the boundary) and yet still wants a moving
 *     bar. Splitting the two lets a call site show motion without asserting a
 *     percentage it cannot measure — assistive tech must not hear invented
 *     numbers.
 *  3. `motion-reduce:transition-none` on the indicator, matching what `spinner`
 *     does for its spin: reduced motion is the default rather than something
 *     each call site has to remember. Upstream eases the fill unconditionally.
 *
 * So: `value` drives what is announced, `indeterminateFillPercent` drives what is
 * painted when nothing can be announced. It is ignored whenever `value` is a
 * determinate number.
 *
 * The fill mirrors Radix's own validity rule rather than treating `value` as a
 * literal percentage, so what is painted can never disagree with what is
 * announced: Radix scales the announcement by `max` and demotes an out-of-range
 * `value` back to indeterminate, and the fill has to follow it in both cases or
 * the bar paints a number nothing is claiming.
 *
 * A progress bar needs an accessible name. Prefer `aria-labelledby` pointing at
 * the visible status text over inventing a second string, and mark any adjacent
 * percentage text `aria-hidden` once the bar carries the number itself.
 */
function Progress({
  className,
  value,
  max,
  indeterminateFillPercent,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indeterminateFillPercent?: number;
}) {
  const resolvedMax = typeof max === 'number' && max > 0 ? max : 100;
  const requestedFill =
    typeof value === 'number' && value >= 0 && value <= resolvedMax
      ? (value / resolvedMax) * 100
      : (indeterminateFillPercent ?? 0);
  // The determinate branch is in range by construction; this clamps a caller
  // that asks for an impossible indeterminate fill.
  const fillPercent = Math.min(100, Math.max(0, requestedFill));

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn(
        'relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - fillPercent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
