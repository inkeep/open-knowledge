import type { ReactNode } from 'react';

export function SkillModeBanner({
  icon,
  children,
  actions,
}: {
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/35 px-3 py-2">
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
