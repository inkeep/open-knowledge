/**
 * Failure-state surface for the docked terminal. When the shell exits or the
 * PTY crashes the canvas would otherwise freeze on its last output with no cue
 * that it is dead — this overlay makes the exit visible and offers the only way
 * back: a fresh PTY in the same window/cwd.
 *
 * It is `role="alert"` because the terminal is non-functional until restart, so
 * the state change must reach a screen-reader user even when focus is elsewhere.
 * The raw `error` string from main is intentionally not rendered (it is an
 * internal diagnostic, not user-facing copy); its presence alone distinguishes
 * a crash from a clean exit.
 */
import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

export interface TerminalExitInfo {
  readonly exitCode: number;
  readonly signal: number | null;
  readonly error?: string;
}

interface TerminalExitNoticeProps {
  readonly info: TerminalExitInfo;
  /** Spawn a fresh PTY in the same window/cwd. */
  readonly onRestart: () => void;
}

export function TerminalExitNotice({ info, onRestart }: TerminalExitNoticeProps) {
  const { t } = useLingui();

  let message: string;
  if (info.error != null) {
    message = t`The terminal stopped unexpectedly.`;
  } else if (info.signal != null && info.signal !== 0) {
    message = t`The terminal session ended (signal ${info.signal}).`;
  } else if (info.exitCode !== 0) {
    message = t`The terminal session ended (exit code ${info.exitCode}).`;
  } else {
    message = t`The terminal session ended.`;
  }

  return (
    <div
      role="alert"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/90 dark:bg-transparent p-6 text-center"
    >
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" className="uppercase font-mono" onClick={onRestart}>
        {t`Restart terminal`}
      </Button>
    </div>
  );
}
