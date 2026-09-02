import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface TerminalNoticeBannerProps {
  readonly testId: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss: () => void;
}

export function TerminalNoticeBanner({
  testId,
  children,
  action,
  onDismiss,
}: TerminalNoticeBannerProps) {
  const { t } = useLingui();
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex shrink-0 items-center gap-3 border-border border-b bg-muted px-3 py-2 text-foreground text-xs"
    >
      <p className="min-w-0 flex-1">{children}</p>
      {action}
      <Button
        size="icon"
        variant="ghost"
        aria-label={t`Dismiss`}
        className="size-6 shrink-0"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}
