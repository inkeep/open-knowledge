/**
 * Settings → Link previews — rich preview cards for external links in the
 * editor hover panel. On by default; this section is the per-machine opt-out.
 * Per-machine (project-local scope) because it controls outbound egress: each
 * machine keeps its own choice rather than inheriting one collaborator's egress
 * setting through git.
 *
 * The toggle reads the synchronous project-local CRDT preference (the same
 * pattern as the Search and Sync sections — never the server's resolved state,
 * which round-trips through the persistence debounce + config file-watcher and
 * would make the control appear to lag). Every off → on transition is gated by
 * a confirmation dialog that discloses the egress; on → off commits immediately
 * (the safe direction).
 *
 * Previews of links to other documents in this project are read entirely from
 * the local index with no network request and are always on — this setting
 * gates external links only.
 */
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

export function LinkPreviewsSection() {
  const { t } = useLingui();
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The confirm dialog is opened programmatically (no Radix trigger), so Radix
  // has nothing to restore focus to on close. Keep a handle on the Switch and
  // send focus back there ourselves (WCAG 2.4.3).
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
      // Off → on: gate behind the egress confirmation. On → off is the safe
      // direction and commits immediately.
      setConfirmOpen(true);
      return;
    }
    write(false);
  }

  function onConfirm() {
    // Close only on success so a failed write leaves the dialog open to retry.
    if (write(true)) setConfirmOpen(false);
  }

  return (
    <section
      aria-labelledby="settings-link-previews-title"
      className="space-y-3"
      data-testid="settings-link-previews"
    >
      <div className="space-y-1">
        <h3 id="settings-link-previews-title" className="text-base font-semibold">
          <Trans>Link previews</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Show a preview card when you hover an external link in the editor. This setting applies
            only to this computer.
          </Trans>
        </p>
      </div>

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-link-previews-toggle" className="text-sm font-medium">
              <Trans>External link previews</Trans>
            </label>
            <p className="text-muted-foreground text-1sm" data-testid="settings-link-previews-body">
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
  /** The Switch that initiated the off to on request; focus returns to it on close. */
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Guards every off → on transition. Turning external link previews on is the
 * moment a hovered URL first leaves the machine, so the dialog spells out what
 * is sent, where, and that it's per-machine.
 */
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
          // With no Radix trigger, the default close-auto-focus targets a null
          // triggerRef and focus falls to document.body. Preempt it and return
          // focus to the Switch instead, on confirm, cancel, and Escape alike
          // (same idiom as FrontmatterRow's add-property flow).
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
