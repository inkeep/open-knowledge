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
const SUCCESS_LINGER_MS = 5200;
const CELEBRATE_BURST_MS = 1500;
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
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  const [exiting, setExiting] = useState(false);

  const completedCount = 1 + (steps.file ? 1 : 0) + (steps.askedAi ? 1 : 0);
  const allComplete = completedCount === TOTAL_STEPS;

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

  useEffect(() => {
    if (!exiting) return;
    const done = setTimeout(() => store.markCompleted(), EXIT_MS);
    return () => clearTimeout(done);
  }, [exiting, store]);

  return (
    <>
      {}
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
              ? 'animate-out fade-out-0 zoom-out-95 fill-mode-forwards duration-200'
              : 'animate-in fade-in-0 zoom-in-95 duration-300',
          )}
        >
          {}
          <OkBlob size={36} celebrateSignal={celebrateSignal} />
          <span className="font-medium text-sm">
            <Trans>You're all set up!</Trans>
          </span>
        </section>
      ) : (
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

export function OnboardingCardMount() {
  const visible = useOnboardingCardVisible();
  if (!visible) return null;
  return <OnboardingCard />;
}
