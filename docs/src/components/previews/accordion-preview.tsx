import { ChevronDown, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { resolveLucideIcon } from './lucide-lookup';

export function AccordionPreview({
  title,
  defaultOpen,
  description,
  icon,
  name,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  description?: string;
  icon?: string;
  name?: string;
  children?: ReactNode;
}) {
  const Icon: LucideIcon | null = icon ? (resolveLucideIcon(icon) ?? null) : null;
  return (
    <details
      className="group rounded-md border border-fd-border bg-fd-card/50"
      open={defaultOpen}
      name={name}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-fd-foreground [&::-webkit-details-marker]:hidden">
        {Icon ? <Icon size={16} className="text-fd-muted-foreground" aria-hidden /> : null}
        <span className="flex-1">
          <span className="font-medium">{title}</span>
          {description ? (
            <span className="ml-2 text-fd-muted-foreground text-xs">{description}</span>
          ) : null}
        </span>
        <ChevronDown
          size={16}
          className="text-fd-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-fd-border border-t px-4 py-3 text-fd-foreground text-sm">
        {children}
      </div>
    </details>
  );
}
