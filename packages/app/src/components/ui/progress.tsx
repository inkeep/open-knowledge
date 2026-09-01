import { Progress as ProgressPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

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
