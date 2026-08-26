/**
 * Pending affordance for a terminal that has been asked for but has produced no
 * shell output yet.
 *
 * What it replaces was a featureless `aria-hidden` div, which reads to a user
 * exactly like a keystroke that did nothing — so a cold start that runs long
 * gets re-invoked, and every re-invocation stacks another tab and another login
 * shell, making the contention worse. The pane must say a shell is coming for
 * as long as it is withholding one.
 *
 * The fade-in is a CSS `animation-delay`, not a JS timer: a start that wins the
 * race never flashes the notice, and there is no timer to leak when the shell
 * arrives and unmounts this. Under `motion-reduce` the delay is preserved and
 * only the fade is collapsed (`duration-0`) — clearing the whole animation would
 * hand reduced-motion users the flash the delay exists to prevent.
 *
 * A11y note, deliberately not overclaimed: `opacity: 0` keeps the node in the
 * accessibility tree, but a `role="status"` subtree mounted with its text
 * already present is announced inconsistently across screen reader and browser
 * pairs, because there is no content mutation to observe. `editor/SelectionAnnouncer`
 * is this repo's prior art for guaranteeing announcement — it holds a persistent
 * empty region and writes `textContent` on a later tick. Adopting that shape here
 * has not been done and the announcement has not been tested against a real
 * screen reader, so treat reliable announcement as unverified. What IS fixed
 * relative to the old pane is that the region is no longer `aria-hidden`.
 */
import { useLingui } from '@lingui/react/macro';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface TerminalStartingNoticeProps {
  /**
   * Extra classes. The canvas overlay in `TerminalPanel` passes
   * `pointer-events-none absolute inset-0 z-20`, and the three do separate jobs:
   * `absolute inset-0` resolves against the canvas wrapper, which is what keeps
   * the notice off the readiness / CLI banner strips (they are in-flow siblings
   * ABOVE that box, so nothing overlaps them and nothing else has to protect
   * them); `pointer-events-none` earns its place purely over the canvas, where
   * the notice really does sit on top of the xterm helper textarea that
   * `attachSession` focuses in this same window; and `z-20` matches the exit /
   * refusal overlays that already stack against xterm's positioned layers.
   * `TerminalGate` passes nothing — there it is the whole pane, not an overlay.
   */
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
