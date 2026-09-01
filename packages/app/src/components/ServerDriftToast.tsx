import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ServerDriftToastProps {
  readonly body: string;
  readonly warning: string;
  readonly restartLabel: string;
  readonly cancelLabel: string;
  readonly onRestart: () => void;
  readonly onDismiss: () => void;
}

export function ServerDriftToast({
  body,
  warning,
  restartLabel,
  cancelLabel,
  onRestart,
  onDismiss,
}: ServerDriftToastProps) {
  return (
    <div className="flex w-full gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium text-sm">{body}</p>
        <p className="text-muted-foreground text-sm">{warning}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button size="sm" onClick={onRestart}>
            {restartLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
