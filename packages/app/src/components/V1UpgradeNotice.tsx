import { Trans, useLingui } from '@lingui/react/macro';
import { TriangleAlertIcon, X } from 'lucide-react';
import { Component, type ErrorInfo, lazy, type ReactNode, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import {
  closeV1UpgradeDialog,
  dismissV1UpgradeToast,
  openV1UpgradeDialog,
  setV1UpgradeDialogOpen,
  shouldShowV1AboutCard,
  shouldShowV1CornerToast,
  shouldShowV1HeaderPill,
  shouldShowV1NavigatorCard,
  useV1UpgradeState,
} from '@/lib/v1-upgrade-store';

const LazyV1UpgradeDialog = lazy(() =>
  import('@/components/V1UpgradeDialog').then((mod) => ({ default: mod.V1UpgradeDialog })),
);

class V1UpgradeDialogBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[v1-upgrade-dialog] failed to load or render', error, info.componentStack);
    closeV1UpgradeDialog();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function V1UpgradeDialogHost() {
  const { snapshot, dialogOpen, dialogEverOpened } = useV1UpgradeState();
  if (!dialogEverOpened && !dialogOpen) return null;
  return (
    <V1UpgradeDialogBoundary>
      <Suspense fallback={null}>
        <LazyV1UpgradeDialog
          snapshot={snapshot}
          open={dialogOpen}
          onOpenChange={setV1UpgradeDialogOpen}
        />
      </Suspense>
    </V1UpgradeDialogBoundary>
  );
}

export function V1UpgradeCornerToast() {
  const { t } = useLingui();
  const { snapshot } = useV1UpgradeState();
  if (!shouldShowV1CornerToast(snapshot) || !snapshot) return null;

  const hasOkignore = snapshot.okignoreProjects.length > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="v1-upgrade-corner-toast"
      className="pointer-events-auto shrink-0 rounded-xl bg-gradient-to-br from-[var(--color-azure-600)]/55 to-[var(--color-agent)]/45 p-[1.5px] shadow-lg"
    >
      <div className="space-y-2.5 rounded-[10.5px] bg-popover/95 p-3.5 text-popover-foreground backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <span className="inline-flex items-center rounded-full bg-[var(--color-azure-600)] px-2 py-0.5 text-2xs font-bold text-white">
              1.0
            </span>
            <span>
              <Trans>OpenKnowledge 1.0 is ready</Trans>
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t`Dismiss OpenKnowledge 1.0 notice`}
            onClick={() => dismissV1UpgradeToast()}
            data-testid="v1-upgrade-toast-close"
          >
            <X aria-hidden="true" className="size-3" />
          </Button>
        </div>

        <p className="text-xs leading-snug text-muted-foreground">
          <Trans>Cloud brains and a rebuilt local workspace.</Trans>
        </p>

        {hasOkignore ? (
          <div
            className="inline-flex items-center gap-1.5 rounded-md border border-warning/35 bg-warning/10 px-2 py-1 text-2xs font-medium text-warning"
            data-testid="v1-upgrade-toast-okignore"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
            <span>
              <Trans>Review .okignore before upgrading</Trans>
            </span>
          </div>
        ) : null}

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-7 bg-[var(--color-azure-600)] px-2.5 text-xs text-white hover:bg-[var(--color-azure-700)]"
            onClick={openV1UpgradeDialog}
            data-testid="v1-upgrade-toast-review"
          >
            <Trans>Review 1.0</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => dismissV1UpgradeToast()}
            data-testid="v1-upgrade-toast-not-now"
          >
            <Trans>Not now</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function V1UpgradeHeaderPill() {
  const { snapshot } = useV1UpgradeState();
  if (!shouldShowV1HeaderPill(snapshot) || !snapshot) return null;

  const isReady = snapshot.phase === 'ready';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={openV1UpgradeDialog}
      data-testid="v1-upgrade-header-pill"
      className="h-6 shrink-0 gap-1.5 rounded-full border border-[var(--color-azure-600)]/35 bg-[var(--color-azure-600)]/12 px-2.5 text-2xs font-medium text-[var(--color-azure-700)] hover:bg-[var(--color-azure-600)]/20 hover:text-[var(--color-azure-800)] dark:border-[var(--color-azure-400)]/40 dark:bg-[var(--color-azure-400)]/15 dark:text-[var(--color-azure-300)] dark:hover:bg-[var(--color-azure-400)]/25 dark:hover:text-[var(--color-azure-200)]"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-[var(--color-azure-600)] dark:bg-[var(--color-azure-300)]"
      />
      {isReady ? <Trans>Restart to finish 1.0</Trans> : <Trans>1.0 available</Trans>}
    </Button>
  );
}

export function V1UpgradeNavigatorCard() {
  const { snapshot } = useV1UpgradeState();
  if (!shouldShowV1NavigatorCard(snapshot) || !snapshot) return null;

  const isReady = snapshot.phase === 'ready';

  return (
    <section
      data-testid="v1-upgrade-navigator-card"
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-azure-600)]/30 bg-gradient-to-r from-[var(--color-azure-600)]/10 via-[var(--color-agent)]/10 to-transparent px-4 py-3"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-[var(--color-azure-600)] px-2 py-0.5 text-2xs font-bold text-white">
            1.0
          </span>
          <span className="text-sm font-medium text-foreground">
            <Trans>OpenKnowledge 1.0 is ready</Trans>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          <Trans>Cloud brains and a rebuilt local workspace.</Trans>
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        className="shrink-0 bg-[var(--color-azure-600)] text-white hover:bg-[var(--color-azure-700)]"
        onClick={openV1UpgradeDialog}
        data-testid="v1-upgrade-navigator-review"
      >
        {isReady ? <Trans>Restart to finish 1.0</Trans> : <Trans>Review 1.0</Trans>}
      </Button>
    </section>
  );
}

export function V1UpgradeAboutCard() {
  const { snapshot } = useV1UpgradeState();
  if (!shouldShowV1AboutCard(snapshot) || !snapshot) return null;

  const isReady = snapshot.phase === 'ready';

  return (
    <div
      data-testid="v1-upgrade-about-card"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-azure-600)]/30 bg-gradient-to-r from-[var(--color-azure-600)]/10 via-[var(--color-agent)]/10 to-transparent p-3"
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="inline-flex items-center rounded-full bg-[var(--color-azure-600)] px-2 py-0.5 text-2xs font-bold text-white">
            1.0
          </span>
          <span>
            <Trans>Upgrade to OpenKnowledge 1.0</Trans>
          </span>
        </div>
        <p className="text-1sm text-muted-foreground">
          <Trans>Cloud brains and a rebuilt local workspace. Upgrading is optional.</Trans>
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        className="shrink-0 bg-[var(--color-azure-600)] text-white hover:bg-[var(--color-azure-700)]"
        onClick={openV1UpgradeDialog}
        data-testid="v1-upgrade-about-review"
      >
        {isReady ? <Trans>Restart to finish 1.0</Trans> : <Trans>Review 1.0</Trans>}
      </Button>
    </div>
  );
}
