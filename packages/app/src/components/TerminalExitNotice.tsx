import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

type TerminalStartFailureReason =
  | 'not-started'
  | 'unknown-session'
  | 'host-unavailable'
  | 'host-exited'
  | 'launch-unsupported';

export type TerminalExitInfo =
  | {
      readonly phase: 'exit';
      readonly exitCode: number;
      readonly signal: number | null;
      readonly error?: string;
      readonly hostExited?: true;
    }
  | {
      readonly phase: 'start';
      readonly reason: TerminalStartFailureReason;
      readonly detail?: undefined;
    }
  | {
      readonly phase: 'start';
      readonly reason?: undefined;
      readonly detail?: string;
    };

interface TerminalExitNoticeProps {
  readonly info: TerminalExitInfo;
  readonly onRestart: () => void;
}

export function TerminalExitNotice({ info, onRestart }: TerminalExitNoticeProps) {
  const { t } = useLingui();

  const startFailureCopy = (reason: TerminalStartFailureReason): string => {
    switch (reason) {
      case 'host-unavailable':
        return t`The terminal background service isn't running.`;
      case 'host-exited':
        return t`The terminal background service stopped before the shell could start.`;
      case 'unknown-session':
        return t`This terminal session is no longer available.`;
      case 'not-started':
        return t`The shell for this session was never started.`;
      case 'launch-unsupported':
        return t`The terminal can't run this command in the configured shell.`;
    }
  };

  let message: string;
  if (info.phase === 'start') {
    message = t`The terminal couldn't start.`;
  } else if (info.error != null || info.hostExited === true) {
    message = t`The terminal stopped unexpectedly.`;
  } else if (info.signal != null && info.signal !== 0) {
    message = t`The terminal session ended (signal ${info.signal}).`;
  } else if (info.exitCode !== 0) {
    message = t`The terminal session ended (exit code ${info.exitCode}).`;
  } else {
    message = t`The terminal session ended.`;
  }

  const reasonCopy =
    info.phase !== 'start' || info.reason === undefined ? null : startFailureCopy(info.reason);

  return (
    <div
      role="alert"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/90 dark:bg-transparent p-6 text-center"
    >
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      {reasonCopy !== null ? (
        <p className="max-w-sm text-sm text-muted-foreground/80">{reasonCopy}</p>
      ) : info.phase === 'start' && info.detail !== undefined && info.detail !== '' ? (
        <p className="max-w-sm break-words font-mono text-muted-foreground/80 text-xs">
          {info.detail}
        </p>
      ) : null}
      <Button size="sm" variant="outline" className="uppercase font-mono" onClick={onRestart}>
        {info.phase === 'start' ? t`Try again` : t`Restart terminal`}
      </Button>
    </div>
  );
}
