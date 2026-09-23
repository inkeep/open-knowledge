import type { ReactNode } from 'react';
import { useRotatingSuggestion } from '@/hooks/use-rotating-suggestion';
import { cn } from '@/lib/utils';

export function RotatingComposerPlaceholder({
  phrases,
  rotating,
  className,
  testId,
}: {
  phrases: readonly string[];
  rotating: boolean;
  className?: string;
  testId?: string;
}): ReactNode {
  const { text, visible } = useRotatingSuggestion(phrases, rotating);
  if (text === '') return null;
  return (
    <div
      aria-hidden
      data-testid={testId}
      className={cn(
        'pointer-events-none absolute inset-0 text-base leading-[1.5] text-muted-foreground/60 transition-opacity duration-500 ease-in-out md:text-sm',
        visible ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      <span
        data-rotating-placeholder={text}
        className="block min-w-0 truncate before:content-[attr(data-rotating-placeholder)]"
      />
    </div>
  );
}
