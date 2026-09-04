import { Copy, Link } from 'lucide-react';
import type { ReactNode } from 'react';

export function MirrorSourcePreview({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-fd-border border-l-4 border-l-fd-primary bg-fd-card/50 px-4 py-3 text-fd-foreground text-sm">
      <div className="mb-2 flex items-center gap-2 text-fd-muted-foreground text-xs">
        <Copy size={12} aria-hidden />
        <span className="font-mono">source id={id}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function MirrorPreview({
  src,
  anchor,
  children,
}: {
  src: string;
  anchor: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-fd-border border-l-4 border-l-fd-muted-foreground/40 bg-fd-muted/30 px-4 py-3 text-fd-foreground text-sm">
      <div className="mb-2 flex items-center gap-2 text-fd-muted-foreground text-xs">
        <Link size={12} aria-hidden />
        <span>
          Mirror of <span className="font-mono">{src}</span>
          {' → '}
          <span className="font-mono">#{anchor}</span> — read-only
        </span>
      </div>
      <div className="flex flex-col gap-2 opacity-90">{children}</div>
    </div>
  );
}
