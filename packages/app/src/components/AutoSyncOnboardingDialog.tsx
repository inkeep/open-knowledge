import { Trans, useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import {
  AutoSyncEnableDialogIntro,
  AutoSyncEnableWarning,
} from '@/components/AutoSyncEnableWarning';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
} from '@/components/ui/dialog';
import { useSyncEnabledWriter } from '@/hooks/use-enable-sync-with-confirm';

interface AutoSyncOnboardingDialogProps {
  open: boolean;
  onResolved: () => void;
}

export function AutoSyncOnboardingDialog({ open, onResolved }: AutoSyncOnboardingDialogProps) {
  const { t } = useLingui();
  const writer = useSyncEnabledWriter();

  function persistChoice(enabled: boolean): void {
    if (writer === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
    const result = writer(enabled);
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
    <DialogRoot open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <AutoSyncEnableDialogIntro />
        </DialogHeader>

        <DialogBody>
          <AutoSyncEnableWarning />
          <p className="mt-3 text-1sm text-muted-foreground">
            <Trans>
              You can turn this on later in <span className="font-medium">Settings → Sync</span>.
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
            <Trans>Enable auto-sync</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
