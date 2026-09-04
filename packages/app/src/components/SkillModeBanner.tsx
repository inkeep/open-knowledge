// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SkillModeBanner({
  icon,
  children,
  actions,
  reserveRightGutter,
}: {
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  reserveRightGutter?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/35 px-3 py-2',
        reserveRightGutter && 'pr-10',
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5 text-muted-foreground text-sm">
        <span className="mt-0.5 shrink-0">{icon}</span>
        {}
        <p className="line-clamp-2">{children}</p>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
