/**
 * First-run onboarding checklist card, shown in the sidebar footer for a
 * genuinely new desktop user. Three momentum steps:
 *   1. Create your first project — always pre-checked (endowed progress; the
 *      user is already inside their first project when the card shows).
 *   2. Create your first file — shows the ⌘N shortcut.
 *   3. Ask AI — shows the ⌘L shortcut.
 *
 * The card is informational: steps check off as the user performs the actions
 * (⌘N, ⌘L) in the editor; the rows themselves are not interactive. The
 * completion checkbox is a decorative, full-opacity status indicator
 * (aria-hidden); completion is conveyed to assistive tech via the strikethrough
 * label plus an sr-only marker.
 *
 * On completing all three steps the card celebrates in place — the OK blob
 * mascot throws a firework burst beside an "all set up" message — then lingers
 * briefly and marks itself completed so it never returns (the visibility gate
 * keys off `completed`). Visibility gating lives at the mount site
 * (useOnboardingCardVisible).
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Kbd } from '@/components/ui/kbd';
import { useOnboardingCardVisible } from '@/hooks/use-onboarding-card-visible';
import { useOnboardingFileCompletion } from '@/hooks/use-onboarding-file-completion';
import { formatShortcut, type KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import {
  type OnboardingCardStore,
  onboardingCardStore,
  useOnboardingCardState,
} from '@/lib/onboarding-card-store';
import { cn } from '@/lib/utils';

const TOTAL_STEPS = 3;
/** How long the celebration lingers before it starts exiting. */
const SUCCESS_LINGER_MS = 5200;
/** Re-fire the blob's firework on this cadence so the celebration stays lively. */
const CELEBRATE_BURST_MS = 1500;
/** Exit-animation length — the card stays mounted this long so the fade-out can
    play before `markCompleted` unmounts it. Matches the `duration-200` class. */
const EXIT_MS = 220;

function StepRow({
  complete,
  label,
  shortcutId,
}: {
  complete: boolean;
  label: React.ReactNode;
  shortcutId?: KeyboardShortcutId;
}) {
  return (
    <li className="flex items-center gap-2 py-0.5 text-sm">
      <Checkbox
        checked={complete}
        disabled
        aria-hidden
        tabIndex={-1}
        // Decorative status indicator — never interactive, but rendered at full
        // opacity (override the disabled dim, which is meant for real form fields).
        className="pointer-events-none opacity-100 disabled:opacity-100"
      />
      <span className={complete ? 'flex-1 text-muted-foreground/60' : 'flex-1'}>
        {complete ? (
          <span className="sr-only">
            <Trans>Completed:</Trans>{' '}
          </span>
        ) : null}
        {label}
      </span>
      {shortcutId ? <Kbd>{formatShortcut(shortcutId)}</Kbd> : null}
    </li>
  );
}

export function OnboardingCard({
  store = onboardingCardStore,
  lingerMs = SUCCESS_LINGER_MS,
}: {
  store?: OnboardingCardStore;
  lingerMs?: number;
}) {
  const { t } = useLingui();
  const { steps } = useOnboardingCardState(store);
  useOnboardingFileCompletion(store);
  // Incremented to (re)fire the blob's firework — once on completion, then on an
  // interval so the celebration keeps popping over its full dwell rather than
  // bursting once and going static.
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  // Drives the exit animation: after the linger we flip `exiting` (plays the
  // fade-out) and only then unmount via markCompleted, so the close isn't abrupt.
  const [exiting, setExiting] = useState(false);

  const completedCount = 1 + (steps.file ? 1 : 0) + (steps.askedAi ? 1 : 0);
  const allComplete = completedCount === TOTAL_STEPS;

  // Terminal success: kick off the celebration, keep it lively with repeated
  // bursts, then begin the exit after the linger.
  useEffect(() => {
    if (!allComplete) return;
    setCelebrateSignal((n) => n + 1);
    const burst = setInterval(() => setCelebrateSignal((n) => n + 1), CELEBRATE_BURST_MS);
    const startExit = setTimeout(() => {
      clearInterval(burst);
      setExiting(true);
    }, lingerMs);
    return () => {
      clearInterval(burst);
      clearTimeout(startExit);
    };
  }, [allComplete, lingerMs]);

  // Once exiting, let the fade-out play, then mark completed (which unmounts the
  // card via the visibility gate).
  useEffect(() => {
    if (!exiting) return;
    const done = setTimeout(() => store.markCompleted(), EXIT_MS);
    return () => clearTimeout(done);
  }, [exiting, store]);

  return (
    <>
      {/* Live region mounted unconditionally (pre-registered empty) so the
          completion announcement is reliable on VoiceOver/Safari — a region
          added and populated in the same render cycle is missed. Reduced-motion
          users who can't see the blob celebration rely on this. WCAG 4.1.3. */}
      <div className="sr-only" role="status" aria-live="polite">
        {allComplete ? t`You're all set up!` : ''}
      </div>

      {allComplete ? (
        <section
          aria-hidden
          className={cn(
            'mx-2 mb-1 flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-card-foreground',
            'motion-reduce:animate-none motion-reduce:duration-0',
            exiting
              ? // fill-mode-forwards holds the faded-out end state until unmount;
                // without it tw-animate-css reverts to opacity 1 at the end (a flash).
                'animate-out fade-out-0 zoom-out-95 fill-mode-forwards duration-200'
              : 'animate-in fade-in-0 zoom-in-95 duration-300',
          )}
        >
          {/* celebrateSignal fires Blobby's happy-eyes + firework burst; bumped
              on an interval so the celebration keeps popping over its dwell. */}
          <OkBlob size={36} celebrateSignal={celebrateSignal} />
          <span className="font-medium text-sm">
            <Trans>You're all set up!</Trans>
          </span>
        </section>
      ) : (
        // aria-labelledby (not aria-label) so landmark nav and the visible
        // heading announce one string.
        <section
          aria-labelledby="onboarding-card-heading"
          className="mx-2 mb-1 rounded-lg border bg-card px-4 py-3 text-card-foreground"
        >
          <header className="mb-3 flex items-center justify-between">
            <h2 id="onboarding-card-heading" className="font-medium text-sm">
              <Trans>Get set up</Trans>
            </h2>
            <span className="text-muted-foreground/60 text-xs tabular-nums">
              {`${completedCount} / ${TOTAL_STEPS}`}
            </span>
          </header>

          <ul className="flex flex-col gap-2">
            <StepRow complete label={<Trans>Create your first project</Trans>} />
            <StepRow
              complete={steps.file}
              label={<Trans>Create your first file</Trans>}
              shortcutId="new-item"
            />
            <StepRow
              complete={steps.askedAi}
              label={<Trans>Ask AI</Trans>}
              shortcutId="open-ask-ai"
            />
          </ul>

          <footer className="-mb-1 mt-2 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-muted-foreground text-xs"
              onClick={() => store.dismiss()}
            >
              <Trans>Dismiss</Trans>
            </Button>
          </footer>
        </section>
      )}
    </>
  );
}

/**
 * Mount point: evaluates the visibility predicate and renders the card inline in
 * the sidebar footer for a genuinely-new desktop user. Renders nothing on
 * web/CLI (no desktop host), where the predicate never activates.
 */
export function OnboardingCardMount() {
  const visible = useOnboardingCardVisible();
  if (!visible) return null;
  return <OnboardingCard />;
}
