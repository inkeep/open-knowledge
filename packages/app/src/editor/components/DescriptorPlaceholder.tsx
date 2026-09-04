import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

interface DescriptorPlaceholderProps extends Omit<React.ComponentProps<'div'>, 'onClick'> {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  selected?: boolean;
}

export function DescriptorPlaceholder({
  label,
  Icon,
  onClick,
  selected,
  className,
  ...rest
}: DescriptorPlaceholderProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <button> intercepts mousedown and breaks the wrapper's HTML5 drag-to-reorder. The wrapper's handleKeyDown also covers Enter/Space activation when selected; the local onKeyDown below provides a self-contained a11y story.
    <div
      {...rest}
      role="button"
      tabIndex={-1}
      contentEditable={false}
      data-descriptor-placeholder=""
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-transparent px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
