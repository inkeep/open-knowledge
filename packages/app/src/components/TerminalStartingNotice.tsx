import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const TERMINAL_SLOW_NOTICE_MS = 8_000;

interface TerminalStartingNoticeProps {
  readonly className?: string;
}

export function TerminalStartingNotice({ className }: TerminalStartingNoticeProps) {
  const { t } = useLingui();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), TERMINAL_SLOW_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      data-testid="terminal-starting-notice"
      data-slow={slow ? 'true' : undefined}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-3 overflow-y-auto bg-background px-6 text-center text-muted-foreground text-sm',
        'fade-in-0 animate-in duration-200 [animation-delay:400ms] [animation-fill-mode:backwards] motion-reduce:duration-0',
        className,
      )}
    >
      <div role="status" className="flex flex-col items-center gap-3">
        <span className="flex items-center gap-2.5">
          <Spinner aria-hidden="true" />
          {t`Starting terminal…`}
        </span>
        {slow ? (
          <p className="max-w-sm">
            {t`This is taking longer than usual. Reloading the window usually clears it.`}
          </p>
        ) : null}
      </div>
      {slow ? (
        <Button className="pointer-events-auto" onClick={() => window.location.reload()}>
          {t`Reload`}
        </Button>
      ) : null}
    </div>
  );
}
