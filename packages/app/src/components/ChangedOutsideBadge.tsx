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
      className="inline-flex h-5 shrink-0 items-center rounded border border-yellow-500/40 bg-yellow-500/10 px-1 text-[10px] text-yellow-600 uppercase tracking-wide"
      data-testid={testId}
      {...(title !== undefined ? { title } : {})}
    >
      <Trans>changed outside</Trans>
    </span>
  );
}
