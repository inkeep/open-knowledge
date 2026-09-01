import type { ReactNode } from 'react';

export function ComponentPreview({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-6 rounded-lg border border-fd-border bg-fd-card">
      <div className="border-fd-border border-b px-4 py-2 text-fd-muted-foreground text-xs uppercase tracking-wide">
        Preview
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}
