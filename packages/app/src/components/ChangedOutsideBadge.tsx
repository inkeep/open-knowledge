import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

/**
 * The "changed outside" chip.
 *
 * Passive disclosure: something outside OK rewrote this path's form since OK
 * last wrote it. There is no action attached — OK only writes on an explicit
 * click, and the surrounding rows always show what is on disk now.
 *
 * The wrapper is the caller's, deliberately: the install menu explains itself
 * through a Radix tooltip (native `title` does not render while the window is
 * unfocused, which is exactly when someone reads that menu), while the settings
 * folder rows use a plain `title`. Converging those is a UX decision, not a
 * consequence of sharing the chip.
 */
export function ChangedOutsideBadge({
  testId,
  title,
}: {
  testId: string;
  title?: string;
}): ReactNode {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded border border-yellow-500/40 bg-yellow-500/10 px-1 text-[10px] text-yellow-600 uppercase tracking-wide"
      data-testid={testId}
      {...(title !== undefined ? { title } : {})}
    >
      <Trans>changed outside</Trans>
    </span>
  );
}
