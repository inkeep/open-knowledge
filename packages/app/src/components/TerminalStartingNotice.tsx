import { useLingui } from '@lingui/react/macro';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface TerminalStartingNoticeProps {
  readonly className?: string;
}

export function TerminalStartingNotice({ className }: TerminalStartingNoticeProps) {
  const { t } = useLingui();
  return (
    <div
      role="status"
      data-testid="terminal-starting-notice"
      className={cn(
        'flex h-full w-full items-center justify-center gap-2.5 bg-background px-6 text-center text-muted-foreground text-sm',
        'fade-in-0 animate-in duration-200 [animation-delay:400ms] [animation-fill-mode:backwards] motion-reduce:duration-0',
        className,
      )}
    >
      <Spinner aria-hidden="true" />
      {t`Starting terminal…`}
    </div>
  );
}
