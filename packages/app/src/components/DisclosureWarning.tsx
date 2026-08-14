import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export function DisclosureWarning({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex flex-col gap-5 text-sm">
      <p className="flex items-center gap-1.5 font-mono text-xs font-semibold tracking-wider uppercase">
        <span aria-hidden="true" className="mb-[3px] flex items-center justify-center">
          ◇
        </span>
        <Trans>Heads up</Trans>
      </p>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

export function DisclosureWarningItem({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
