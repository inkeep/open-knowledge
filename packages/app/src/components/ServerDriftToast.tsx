import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ServerDriftToastProps {
  readonly body: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly dismissLabel: string;
  readonly onAction: () => void;
  readonly onDismiss: () => void;
}

export function ServerDriftToast({
  body,
  detail,
  actionLabel,
  dismissLabel,
  onAction,
  onDismiss,
}: ServerDriftToastProps) {
  return (
    <div className="flex w-full gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="wrap-break-word font-medium text-sm">{body}</p>
        <p className="wrap-break-word text-muted-foreground text-sm">{detail}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {dismissLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
