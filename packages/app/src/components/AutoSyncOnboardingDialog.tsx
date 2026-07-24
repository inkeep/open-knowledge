/**
 * AutoSyncOnboardingDialog — first-run prompt explaining git sync.
 *
 * Shown once per project when the sync engine reports a remote exists AND this
 * machine has not chosen a sync mode. `resolveAutoSyncOnboarding` decides
 * whether to show it and which `variant` to pass: 'full' (bidirectional, the
 * push-capable prompt) or 'pull' (one-directional, for a push-denied follower).
 * Both buttons write `autoSync.mode` through the project-local ConfigBinding so
 * the choice flows down the standard Y.Text → persistence-hook → file-watcher →
 * SyncEngine pipeline.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import {
  AutoSyncEnableDialogIntro,
  AutoSyncEnableWarning,
} from '@/components/AutoSyncEnableWarning';
import type { AutoSyncOnboardingVariant } from '@/components/auto-sync-onboarding-gate';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
} from '@/components/ui/dialog';
import { useSyncModeWriter } from '@/hooks/use-enable-sync-with-confirm';

interface AutoSyncOnboardingDialogProps {
  open: boolean;
  variant: AutoSyncOnboardingVariant;
  onResolved: () => void;
}

export function AutoSyncOnboardingDialog({
  open,
  variant,
  onResolved,
}: AutoSyncOnboardingDialogProps) {
  const { t } = useLingui();
  const writer = useSyncModeWriter();

  function persistChoice(enabled: boolean): void {
    if (writer === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
    const result = writer(enabled ? (variant === 'follow' ? 'follow' : 'full') : 'off');
    if (!result.ok) {
      const detail = result.error;
      toast.error(
        enabled
          ? t`Could not enable sync: ${detail}`
          : t`Could not save sync preference: ${detail}`,
      );
      return;
    }
    onResolved();
  }

  return (
    <DialogRoot
      open={open}
      // Both buttons explicitly call onResolved; ignore Radix close-on-outside-
      // click / Esc so the user doesn't accidentally clear the prompt without
      // making a real choice.
      onOpenChange={() => {}}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <AutoSyncEnableDialogIntro variant={variant} />
        </DialogHeader>

        <DialogBody>
          <AutoSyncEnableWarning variant={variant} />
          <p className="mt-3 text-1sm text-muted-foreground">
            <Trans>
              You can change this later in <span className="font-medium">Settings → Sync</span>.
            </Trans>
          </p>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            className="uppercase font-mono"
            onClick={() => persistChoice(false)}
            disabled={writer === null}
          >
            <Trans>Keep disabled</Trans>
          </Button>
          <Button onClick={() => persistChoice(true)} disabled={writer === null}>
            {variant === 'follow' ? <Trans>Enable Follow</Trans> : <Trans>Enable auto-sync</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
