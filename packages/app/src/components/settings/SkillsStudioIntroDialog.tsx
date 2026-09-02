import { Trans, useLingui } from '@lingui/react/macro';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillDestinationList } from '@/components/SkillDestinationList';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OkIntegrationsStatus } from '@/lib/desktop-bridge-types';
import { useBuiltinSkillBlurb } from './builtin-skill-copy';

export interface SkillsStudioIntroDialogProps {
  open: boolean;
  onDismiss: () => void;
  offer: OkIntegrationsStatus['skills'][number] | null;
  onInstall: () => void;
  busy?: boolean;
}

export function SkillsStudioIntroDialog({
  open,
  onDismiss,
  offer,
  onInstall,
  busy = false,
}: SkillsStudioIntroDialogProps) {
  const { t } = useLingui();
  const blurbFor = useBuiltinSkillBlurb();
  const canInstall = offer !== null && offer.resolvedHosts.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="skills-studio-intro">
        <DialogHeader>
          <DialogTitle>
            <Trans>Skills Studio</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans comment="First-visit explanation of what the Skills Studio settings page is for">
              Skills teach your AI tools repeatable tasks. Install the ones OpenKnowledge ships, or
              write your own in the editor's Skills sidebar.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {offer !== null && (
          <DialogBody className="flex flex-col gap-3 py-1">
            <span className="text-xs font-medium text-muted-foreground">
              <Trans comment="Label above the optional skill offered on first visit">
                You can add
              </Trans>
            </span>
            <div className="rounded-md border border-border bg-card/50">
              <SkillConsentRow
                name={offer.name}
                description={blurbFor(offer.id) ?? offer.description}
                hosts={offer.resolvedHosts.map((h) => h.editor)}
              />
            </div>
            {canInstall && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  <Trans>Installs to</Trans>
                </span>
                <SkillDestinationList paths={offer.paths} />
              </div>
            )}
          </DialogBody>
        )}

        <DialogFooter>
          {offer === null ? (
            <Button onClick={onDismiss} data-testid="skills-studio-intro-ack">
              <Trans comment="Sole button when the intro has nothing left to offer">Got it</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={onDismiss}
                data-testid="skills-studio-intro-dismiss"
              >
                <Trans comment="Declines the first-visit skill offer; the row on the page keeps it available">
                  Not now
                </Trans>
              </Button>
              <Button
                onClick={onInstall}
                disabled={busy || !canInstall}
                aria-label={t`Install ${offer.name}`}
                data-testid="skills-studio-intro-install"
              >
                <Trans>Install</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
