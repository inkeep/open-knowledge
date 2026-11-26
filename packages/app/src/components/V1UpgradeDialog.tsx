import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, CheckCircle2, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import type {
  OkV1UpgradeErrorCode,
  OkV1UpgradeOptInFailure,
  OkV1UpgradeSnapshot,
} from '@/lib/desktop-bridge-types';
import { useRelaunchInFlight } from '@/lib/relaunch-store';
import { restoreV1UpgradeDialogFocus, startV1UpgradeOptIn } from '@/lib/v1-upgrade-store';

type LocalV1ErrorCode = 'busy' | 'not-available' | 'start-failed' | 'relaunch-failed';

interface V1UpgradeDialogProps {
  snapshot: OkV1UpgradeSnapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface V1UpgradeDialogBodyProps {
  snapshot: OkV1UpgradeSnapshot;
  onOpenChange: (open: boolean) => void;
}

interface PendingRelaunchState {
  readonly phase: 'ready' | 'error';
  readonly atSnapshot: OkV1UpgradeSnapshot;
}

function V1UpgradeDialogInner({ snapshot, onOpenChange }: V1UpgradeDialogBodyProps) {
  const { t } = useLingui();
  const [okignoreAcked, setOkignoreAcked] = useState(false);
  const [pendingRelaunch, setPendingRelaunch] = useState<PendingRelaunchState | null>(null);
  const [localErrorCode, setLocalErrorCode] = useState<LocalV1ErrorCode | null>(null);
  const relaunchInFlight = useRelaunchInFlight();

  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const openExternal = (url: string) => {
    if (!bridge) return;
    void bridge.shell.openExternal(url).catch((err: unknown) => {
      console.warn('[v1-upgrade-dialog] openExternal failed', err);
    });
  };

  const resolveErrorMessage = (
    code: OkV1UpgradeErrorCode | LocalV1ErrorCode | null,
  ): string | null => {
    if (code === null) return null;
    switch (code) {
      case 'busy':
        return t`Another update check is already running. Try again in a moment.`;
      case 'not-available':
        return t`OpenKnowledge 1.0 is currently unavailable for in-app download.`;
      case 'start-failed':
        return t`Couldn't start the 1.0 download.`;
      case 'feed-mismatch':
        return t`The update feed did not offer a matching OpenKnowledge 1.0 build, so nothing was installed. Download it manually from openknowledge.ai/download.`;
      case 'already-staged':
        return t`Another update is already ready to install. Restart first, then upgrade to 1.0.`;
      case 'download-failed':
        return t`Couldn't download OpenKnowledge 1.0. Try again or download it manually.`;
      case 'relaunch-failed':
        return t`Couldn't restart to install OpenKnowledge 1.0. Download it manually or quit and reopen the app.`;
      case 'timeout':
        return t`Timed out checking for OpenKnowledge 1.0. Try again or download it manually.`;
      default: {
        const _exhaustive: never = code;
        return _exhaustive;
      }
    }
  };

  const handleOptInFailure = (reason: OkV1UpgradeOptInFailure): void => {
    switch (reason) {
      case 'manual-download-required':
        openExternal(snapshot.manualDownloadUrl);
        return;
      case 'busy':
        setLocalErrorCode('busy');
        return;
      case 'not-available':
        setLocalErrorCode('not-available');
        return;
      default: {
        const _exhaustive: never = reason;
        void _exhaustive;
      }
    }
  };

  const hasOkignore = snapshot.okignoreProjects.length > 0;
  const okignoreList = snapshot.okignoreProjects.join(', ');
  const localRelaunchActive =
    localErrorCode === null &&
    pendingRelaunch !== null &&
    (pendingRelaunch.phase === 'ready'
      ? snapshot.phase === 'ready'
      : snapshot === pendingRelaunch.atSnapshot);
  const isRelaunching = relaunchInFlight || localRelaunchActive;
  const isBusy = snapshot.phase === 'checking' || snapshot.phase === 'downloading' || isRelaunching;
  const isReady = snapshot.phase === 'ready';
  const isRelaunchRetry = snapshot.phase === 'error' && snapshot.errorCode === 'relaunch-failed';
  const activeErrorCode: OkV1UpgradeErrorCode | LocalV1ErrorCode | null =
    localErrorCode ?? (snapshot.phase === 'error' ? snapshot.errorCode : null);
  const isAlreadyStaged = activeErrorCode === 'already-staged';
  const errorMessage = resolveErrorMessage(activeErrorCode);
  const ackBlocked = hasOkignore && !okignoreAcked;
  const versionLabel = `v${snapshot.availableVersion}`;
  const progressValue = snapshot.progressPercent ?? 0;

  const liveAnnouncement =
    snapshot.phase === 'checking' || snapshot.phase === 'downloading'
      ? t`Downloading OpenKnowledge 1.0`
      : isReady
        ? t`OpenKnowledge 1.0 is downloaded and ready to install.`
        : '';

  const handlePrimaryAction = async () => {
    setLocalErrorCode(null);
    if (isReady || isRelaunchRetry) {
      if (!bridge) return;
      setPendingRelaunch({
        phase: isReady ? 'ready' : 'error',
        atSnapshot: snapshot,
      });
      try {
        await bridge.update.relaunchNow();
      } catch (err: unknown) {
        console.warn('[v1-upgrade-dialog] relaunchNow failed', err);
        setPendingRelaunch(null);
        setLocalErrorCode('relaunch-failed');
      }
      return;
    }

    if (!snapshot.canInstallInApp) {
      openExternal(snapshot.manualDownloadUrl);
      return;
    }

    try {
      const result = await startV1UpgradeOptIn();
      if (result && !result.ok) {
        handleOptInFailure(result.reason);
      }
    } catch (err: unknown) {
      console.warn('[v1-upgrade-dialog] optInV1Upgrade failed', err);
      setLocalErrorCode('start-failed');
    }
  };

  return (
    <>
      <span className="sr-only" aria-live="polite" data-testid="v1-upgrade-live-status">
        {liveAnnouncement}
      </span>
      <DialogHeader className="gap-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-[var(--color-azure-600)] px-2 py-0.5 text-2xs font-semibold text-white">
            1.0
          </span>
          <span className="font-mono text-xs text-muted-foreground">{versionLabel}</span>
        </div>
        <DialogTitle>
          <Trans>Upgrade to OpenKnowledge 1.0</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Cloud brains and a rebuilt local workspace. Nothing downloads until you confirm, and
            your Markdown files stay untouched on disk.
          </Trans>
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openExternal(snapshot.releaseNotesUrl)}
            data-testid="v1-upgrade-release-notes"
          >
            <Trans>Release notes</Trans>
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openExternal(snapshot.migrationGuideUrl)}
            data-testid="v1-upgrade-migration-guide"
          >
            <Trans>Migration guide</Trans>
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4 py-1">
        {hasOkignore ? (
          <div
            className="space-y-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
            data-testid="v1-upgrade-okignore-callout"
          >
            <div className="flex items-start gap-2">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <div className="space-y-1">
                <div className="font-semibold">
                  <Trans>.okignore is removed in 1.0</Trans>
                </div>
                <p id="v1-upgrade-okignore-requirement" className="leading-relaxed">
                  <Trans>
                    Detected in {okignoreList}. Move private exclusions to .gitignore or
                    .git/info/exclude before opening these folders in 1.0.
                  </Trans>
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 ps-5.5">
              <Checkbox
                id="v1-upgrade-okignore-ack"
                required
                checked={okignoreAcked}
                onCheckedChange={(checked) => setOkignoreAcked(checked === true)}
                data-testid="v1-upgrade-okignore-checkbox"
              />
              <Label
                htmlFor="v1-upgrade-okignore-ack"
                className="cursor-pointer text-xs leading-snug font-medium text-warning"
              >
                <Trans>I&apos;ve reviewed my .okignore exclusions</Trans>
              </Label>
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            <Trans>What changes</Trans>
          </h3>
          <ul className="list-disc space-y-1.5 ps-4 text-xs leading-relaxed text-muted-foreground">
            <li>
              <Trans>
                <strong className="font-medium text-foreground">
                  Settings and recents start fresh
                </strong>{' '}
                — your Markdown files stay untouched on disk.
              </Trans>
            </li>
            <li>
              {snapshot.hasGitProjects ? (
                <Trans>
                  <strong className="font-medium text-foreground">
                    Built-in Git sync is replaced by Cloud brains
                  </strong>{' '}
                  — commit or save local Git edits before switching.
                </Trans>
              ) : (
                <Trans>
                  <strong className="font-medium text-foreground">
                    Built-in Git sync is replaced by Cloud brains.
                  </strong>
                </Trans>
              )}
            </li>
            <li>
              <Trans>
                <strong className="font-medium text-foreground">CLI renamed</strong> —{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                  ok
                </code>{' '}
                becomes{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                  open-knowledge
                </code>
                .
              </Trans>
            </li>
          </ul>
        </div>

        {snapshot.phase === 'checking' || snapshot.phase === 'downloading' ? (
          <div
            className="space-y-2 rounded-lg border bg-muted/40 p-3"
            data-testid="v1-upgrade-progress"
          >
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
              <span id="v1-upgrade-progress-label">
                {snapshot.phase === 'checking' ? (
                  <Trans>Checking OpenKnowledge 1.0</Trans>
                ) : (
                  <Trans>Downloading OpenKnowledge 1.0</Trans>
                )}
              </span>
              {snapshot.phase === 'downloading' ? (
                <span className="font-mono text-muted-foreground">{progressValue}%</span>
              ) : null}
            </div>
            <Progress
              aria-labelledby="v1-upgrade-progress-label"
              value={snapshot.phase === 'downloading' ? progressValue : undefined}
              indeterminateFillPercent={snapshot.phase === 'checking' ? 25 : undefined}
            />
          </div>
        ) : null}

        {isReady ? (
          <div
            className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-xs text-success"
            data-testid="v1-upgrade-ready"
          >
            <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
            <span>
              {snapshot.autoInstallOnAppQuit ? (
                <Trans>
                  OpenKnowledge 1.0 is downloaded. It installs when you restart now or the next time
                  you quit.
                </Trans>
              ) : (
                <Trans>OpenKnowledge 1.0 is downloaded and ready to install.</Trans>
              )}
            </span>
          </div>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            data-testid="v1-upgrade-error"
          >
            <p className="leading-snug">{errorMessage}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openExternal(snapshot.manualDownloadUrl)}
              data-testid="v1-upgrade-manual-download"
            >
              <Trans>Download manually</Trans>
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          data-testid="v1-upgrade-cancel"
        >
          {isBusy || isReady || isAlreadyStaged ? <Trans>Close</Trans> : <Trans>Not now</Trans>}
        </Button>
        {!isAlreadyStaged ? (
          <Button
            type="button"
            disabled={isBusy || (!isReady && !isRelaunchRetry && ackBlocked)}
            aria-describedby={
              !isReady && !isRelaunchRetry && ackBlocked
                ? 'v1-upgrade-okignore-requirement'
                : undefined
            }
            onClick={() => {
              void handlePrimaryAction();
            }}
            className="bg-[var(--color-azure-600)] text-white hover:bg-[var(--color-azure-700)]"
            data-testid="v1-upgrade-primary"
          >
            {isBusy ? (
              <>
                <Spinner aria-hidden="true" />
                {isRelaunching ? <Trans>Restarting</Trans> : <Trans>Downloading</Trans>}
              </>
            ) : isReady || isRelaunchRetry ? (
              <Trans>Restart &amp; Install 1.0</Trans>
            ) : !snapshot.canInstallInApp ? (
              <>
                <Trans>Download 1.0</Trans>
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </>
            ) : snapshot.phase === 'error' ? (
              <Trans>Retry</Trans>
            ) : (
              <Trans>Download &amp; Upgrade to 1.0</Trans>
            )}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function V1UpgradeDialog({ snapshot, open, onOpenChange }: V1UpgradeDialogProps) {
  if (!snapshot?.availableVersion) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="v1-upgrade-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreV1UpgradeDialogFocus();
        }}
      >
        <V1UpgradeDialogInner snapshot={snapshot} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
