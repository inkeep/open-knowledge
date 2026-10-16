import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export function ChangedOutsideBadge({
  testId,
  title,
}: {
  testId: string;
  title?: string;
}): ReactNode {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded border border-warning/40 bg-warning/10 px-1 text-[10px] text-warning uppercase tracking-wide"
      data-testid={testId}
      {...(title !== undefined ? { title } : {})}
    >
      <Trans>changed outside</Trans>
    </span>
  );
}
