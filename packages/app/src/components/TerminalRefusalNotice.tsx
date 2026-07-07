/**
 * Failure-state surface for a terminal whose shell main refused to start. When
 * `bridge.terminal.create()` resolves `{ ok: false }` the xterm canvas was
 * already opened into the container, so without this notice the user faces a
 * bare focused black box that echoes nothing. This makes the refusal visible
 * and states why, mirroring TerminalExitNotice.
 *
 * It is `role="alert"` because the terminal is non-functional, so the state
 * change must reach a screen-reader user even when focus is elsewhere. The
 * focused canvas is intentionally NOT given focus by the panel for these
 * states; the optional "Close terminal" affordance collapses the dock and
 * returns focus to the editor.
 */
import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

interface TerminalRefusalNoticeProps {
  readonly reason: 'no-project' | 'not-consented';
  /** Release focus / collapse the dock back to the editor. */
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
