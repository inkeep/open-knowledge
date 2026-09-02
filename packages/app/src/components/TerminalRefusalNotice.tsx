import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

interface TerminalRefusalNoticeProps {
  readonly reason: 'no-project' | 'not-consented';
  readonly onClose?: () => void;
}

export function TerminalRefusalNotice({ reason, onClose }: TerminalRefusalNoticeProps) {
  const { t } = useLingui();

  const message =
    reason === 'not-consented'
      ? t`Terminal access isn't enabled for this project.`
      : t`There's no project folder for this window, so a terminal can't start here.`;

  return (
    <div
      role="alert"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center text-foreground"
    >
      <p className="max-w-sm text-sm">{message}</p>
      {onClose ? (
        <Button size="sm" variant="secondary" onClick={onClose}>
          {t`Close terminal`}
        </Button>
      ) : null}
    </div>
  );
}
