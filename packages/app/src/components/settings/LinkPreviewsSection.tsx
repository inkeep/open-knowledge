// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { humanFormat } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { type RefObject, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useConfigContext } from '@/lib/config-provider';
import { SettingsSectionHeader } from './SettingsSectionHeader';

export function LinkPreviewsSection() {
  const { t } = useLingui();
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const switchRef = useRef<HTMLButtonElement | null>(null);

  const enabled = projectLocalConfig?.linkPreviews?.enabled ?? false;
  const bindingReady = projectLocalSynced && projectLocalBinding !== null;

  function write(next: boolean): boolean {
    if (projectLocalBinding === null) {
      toast.error(t`Link preview settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectLocalBinding.patch({ linkPreviews: { enabled: next } });
    if (!result.ok) {
      const detail = humanFormat(result.error);
      toast.error(
        next
          ? t`Failed to enable link previews — ${detail}`
          : t`Failed to disable link previews — ${detail}`,
      );
      return false;
    }
    return true;
  }

  function onToggleRequest(next: boolean) {
    if (next) {
      setConfirmOpen(true);
      return;
    }
    write(false);
  }

  function onConfirm() {
    if (write(true)) setConfirmOpen(false);
  }

  return (
    <section
      aria-labelledby="settings-link-previews-title"
      className="space-y-3"
      data-testid="settings-link-previews"
    >
      <SettingsSectionHeader
        titleId="settings-link-previews-title"
        title={<Trans>Link previews</Trans>}
        scope="project-local"
      >
        <Trans>Show a preview card when you hover an external link in the editor.</Trans>
      </SettingsSectionHeader>

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-link-previews-toggle" className="text-sm font-medium">
              <Trans>External link previews</Trans>
            </label>
            <p
              id="settings-link-previews-toggle-description"
              className="text-muted-foreground text-1sm"
              data-testid="settings-link-previews-body"
            >
              {enabled ? (
                <Trans>
                  On — hovering an external link sends its URL to the destination site to fetch a
                  preview.
                </Trans>
              ) : (
                <Trans>
                  Off — external links show only their URL. No requests leave this computer.
                </Trans>
              )}
            </p>
          </div>
          <Switch
            ref={switchRef}
            id="settings-link-previews-toggle"
            aria-describedby="settings-link-previews-toggle-description"
            checked={enabled}
            disabled={!bindingReady}
            onCheckedChange={onToggleRequest}
            aria-label={
              enabled ? t`Disable external link previews` : t`Enable external link previews`
            }
            data-testid="settings-link-previews-toggle"
          />
        </div>
        <p className="text-muted-foreground text-1sm mt-2">
          <Trans>
            Previews of links to other documents in this project are always on and read from the
            local index — nothing leaves your computer for those.
          </Trans>
        </p>
      </div>

      <EnableLinkPreviewsConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
        returnFocusRef={switchRef}
      />
    </section>
  );
}

interface EnableLinkPreviewsConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

function EnableLinkPreviewsConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  returnFocusRef,
}: EnableLinkPreviewsConfirmDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="settings-link-previews-confirm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Turn on external link previews?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              External link previews show a card with the site name, page title, and description
              when you hover a link.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            <p className="mb-2 font-medium">
              <Trans>This sends the link's address off your machine</Trans>
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <Trans>
                  When you hover an external link, its URL is sent to the destination site to fetch
                  the page's preview metadata — one request per previewed link.
                </Trans>
              </li>
              <li>
                <Trans>
                  Only external links trigger a request. Links to other documents in this project
                  preview from the local index and never leave your computer.
                </Trans>
              </li>
              <li>
                <Trans>This setting is per-machine and isn't shared with collaborators.</Trans>
              </li>
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} data-testid="settings-link-previews-confirm-enable">
            <Trans>Turn on</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
