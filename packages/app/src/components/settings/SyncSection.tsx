/**
 * Sync section — surface the git auto-sync toggle in Settings so users
 * have a deliberate path to re-enable when the header badge is hidden
 * (state === 'disabled' hides the badge).
 *
 * The toggle writes through the project-local ConfigBinding so the choice
 * lands in `<projectDir>/.ok/local/config.yml`; the file watcher then drives
 * the SyncEngine to match.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AuthModal } from '@/components/AuthModal';
import { EnableSyncConfirmDialog } from '@/components/EnableSyncConfirmDialog';
import { PublishToGitHubDialog } from '@/components/PublishToGitHubDialog';
import {
  formatPausedReason,
  shouldDisableSyncSwitch,
  shouldOfferReconnect,
  shouldOfferSignInAgain,
} from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  useEnableSyncWithConfirm,
  useSyncDefaultWriter,
  useSyncEnabledWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';

// The selected committed-default option uses the app's primary blue (the same
// token as the Button default variant), not the muted ToggleGroup default, so
// the active stance reads as clearly chosen and matches the accent used
// elsewhere in the app.
const COMMITTED_DEFAULT_SELECTED_CLASS =
  'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

export function SyncSection() {
  const { t } = useLingui();
  const status = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();
  const writer = useSyncEnabledWriter();
  const defaultWriter = useSyncDefaultWriter();
  const { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm } =
    useEnableSyncWithConfirm(writer);
  const [publishOpen, setPublishOpen] = useState(false);
  // Local AuthModal control for the Sign-in-again affordance surfaced when
  // the probe returns 401. The editor header has its own AuthModal — settings
  // doesn't share it, so the section owns one locally (same pattern as
  // AccountSection).
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // No git remote configured — instead of dead-ending on a CLI instruction,
  // lead with the outcome (back up + share) and offer the existing
  // Publish-to-GitHub wizard, which creates a repo and connects it with no
  // terminal. The raw `git remote add` path stays as an Advanced disclosure
  // for users who already have a repository.
  if (status && !status.hasRemote && status.state === 'dormant') {
    return (
      <section
        aria-labelledby="settings-sync-title"
        className="space-y-4"
        data-testid="settings-sync-empty"
      >
        <div className="space-y-1">
          <h3 id="settings-sync-title" className="text-base font-semibold">
            <Trans>Sync</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              This project lives only on this computer. Connect it to GitHub to back it up and share
              it with other people.
            </Trans>
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">
              <Trans>Connect to GitHub</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>We'll create a repository and start syncing — no terminal needed.</Trans>
            </p>
          </div>
          <Button onClick={() => setPublishOpen(true)} data-testid="settings-sync-setup">
            <Trans>Set up syncing</Trans>
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group gap-1 px-1.5 text-muted-foreground">
              <ChevronRight
                className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
              <Trans>Connect an existing repository</Trans>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="px-1.5 pt-2 text-sm text-muted-foreground">
            <Trans>
              Already have a git repository? Add it with{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                git remote add origin &lt;url&gt;
              </code>{' '}
              in this project's folder. This page updates automatically once a remote is detected.
            </Trans>
          </CollapsibleContent>
        </Collapsible>

        <PublishToGitHubDialog open={publishOpen} onOpenChange={setPublishOpen} />
      </section>
    );
  }

  // Read user intent from the synchronous local CRDT preference (the same
  // binding `useSyncEnabledWriter` writes to). Don't read from the server's
  // engine-state projection — that round-trips through ~2 s persistence
  // debounce + chokidar settle + 100 ms CC1 debounce, making the Switch
  // appear to lag every click.
  const enabled = projectLocalConfig?.autoSync?.enabled ?? false;
  // Mirrors the SyncStatusBadge popover so both surfaces gate identically.
  // Disable on cold start OR on a denied probe; never disable on
  // undefined / unknown / pending (preserves read+write parity).
  const disabledControl = shouldDisableSyncSwitch(
    projectLocalSynced,
    status?.pushPermission?.checkStatus,
  );
  // Whether the body line should carry the no-permission copy inline (instead
  // of the standard "your edits stay local" string + a redundant paragraph
  // underneath). Fires for both the probe-`denied` path AND the in-memory
  // pause path (autoSync was already enabled when probe came back denied —
  // engine sets `pausedReason='no-push-permission'`).
  const isPushDenied =
    status?.pushPermission?.checkStatus === 'denied' ||
    status?.pausedReason === 'no-push-permission';
  const sectionMessage =
    isPushDenied || !status?.pausedReason ? null : formatPausedReason(status.pausedReason);

  // Committed project default (`autoSync.default`) — the maintainer-facing,
  // git-shared seed for everyone's first open. true/false/null map to the three
  // ToggleGroup options; `null` (ask) is the absence of a committed seed.
  const committedDefault = projectConfig?.autoSync?.default ?? null;
  const committedDefaultValue =
    committedDefault === true ? 'on' : committedDefault === false ? 'off' : 'ask';
  function onCommittedDefaultChange(next: string) {
    // Radix single ToggleGroup emits '' when the active item is re-pressed
    // (deselect) — ignore it so there is always exactly one committed stance.
    if (next !== 'ask' && next !== 'on' && next !== 'off') return;
    if (defaultWriter === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
    // 'ask' writes null, which clears the committed key (RFC 7396 merge-patch) →
    // unanswered machines see the onboarding prompt again.
    const value = next === 'on' ? true : next === 'off' ? false : null;
    const result = defaultWriter(value);
    if (!result.ok) {
      const detail = result.error;
      toast.error(t`Failed to update the project sync default — ${detail}`);
    }
  }

  return (
    <section aria-labelledby="settings-sync-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="settings-sync-title" className="text-base font-semibold">
          <Trans>Sync</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Auto-sync pushes/pulls commits to your git remote on intervals and on save. Toggling on
            requires confirmation.
          </Trans>
        </p>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-sync-toggle" className="text-sm font-medium">
              <Trans>Git auto-sync</Trans>
            </label>
            <p className="text-muted-foreground text-1sm" data-testid="settings-sync-body">
              {isPushDenied ? (
                // Probe denied (or engine paused in-memory because autoSync was
                // already on when probe denied). Replace the standard body copy
                // with the permission-specific message — the redundant
                // sectionMessage paragraph below is suppressed in this case.
                // "Paused", not "off": the user's preference is still on (the
                // toggle shows it), sync is just blocked. Signed-out vs genuine
                // read-only get different remedies.
                shouldOfferReconnect(status?.pushPermission) ? (
                  <Trans>Auto-sync is paused — sign in to resume.</Trans>
                ) : (
                  <Trans>
                    Auto-sync is paused — you don't have permission to push to this repo.
                  </Trans>
                )
              ) : enabled ? (
                <Trans>
                  Auto-sync is on — your commits push and remote changes pull on intervals.
                </Trans>
              ) : (
                <Trans>
                  Auto-sync is off — your edits stay local until you commit and push manually.
                </Trans>
              )}
            </p>
            {status?.remote ? (
              <p
                className="text-muted-foreground text-1sm truncate"
                data-testid="settings-sync-remote"
              >
                <Trans>Connected to</Trans>{' '}
                {status.remote.webUrl ? (
                  <a
                    href={status.remote.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:text-primary hover:underline inline-flex items-center gap-0.5"
                    aria-label={t`Open ${status.remote.label} on GitHub (opens in a new tab)`}
                    data-testid="settings-sync-remote-link"
                  >
                    <span>{status.remote.label}</span>
                    <ArrowUpRight className="inline size-3.5" aria-hidden />
                  </a>
                ) : (
                  <span
                    className="font-medium text-foreground"
                    data-testid="settings-sync-remote-label"
                  >
                    {status.remote.label}
                  </span>
                )}
              </p>
            ) : null}
          </div>
          <Switch
            id="settings-sync-toggle"
            checked={enabled}
            disabled={disabledControl}
            onCheckedChange={onToggleRequest}
            aria-label={
              status?.pushPermission?.checkStatus === 'denied'
                ? t`Sync disabled — you don't have permission to push`
                : enabled
                  ? t`Disable git auto-sync`
                  : t`Enable git auto-sync`
            }
            data-testid="settings-sync-toggle"
          />
        </div>
        {sectionMessage !== null && (
          <p className="text-1sm text-muted-foreground mt-2" data-testid="settings-sync-reason">
            {sectionMessage}
          </p>
        )}
        {shouldOfferSignInAgain(status?.pushPermission) && (
          // Probe-401 ('unknown/token-invalid') surfaces a Sign in again
          // affordance without disabling sync. Mirrors the popover so both
          // surfaces gate identically.
          <div className="mt-2 flex items-start gap-2" data-testid="settings-sync-signin-again">
            <p className="text-1sm text-muted-foreground flex-1 min-w-0">
              <Trans>Your GitHub session expired — sign in again to verify push access.</Trans>
            </p>
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => setAuthModalOpen(true)}
            >
              <Trans>Sign in</Trans>
            </Button>
          </div>
        )}
        {shouldOfferReconnect(status?.pushPermission) && (
          // Signed-out denial ('denied/not-authenticated') — reconnecting
          // resumes sync (the body copy above reads "sign in to resume"), so
          // surface the button. Mirrors the popover's reconnect affordance.
          <div className="mt-2 flex justify-start" data-testid="settings-sync-reconnect">
            {/* Default size (not xs) to match the None/On/Off toggle row above:
                both resolve to h-8 / px-2.5 / text-sm. */}
            <Button variant="outline" onClick={() => setAuthModalOpen(true)}>
              <Trans>Sign in</Trans>
            </Button>
          </div>
        )}
      </div>
      <div className="rounded-md border p-3 space-y-2" data-testid="settings-sync-default">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">
            <Trans>Shared default</Trans>
          </div>
          <p className="text-muted-foreground text-1sm">
            <Trans>
              Set the auto-sync default for users opening this project for the first time. This
              setting is committed to your repository.
            </Trans>
          </p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={2}
          value={committedDefaultValue}
          onValueChange={onCommittedDefaultChange}
          disabled={!projectSynced}
          aria-label={t`Shared auto-sync default`}
          data-testid="settings-sync-default-toggle"
        >
          <ToggleGroupItem
            value="ask"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-ask"
          >
            <Trans>None</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="on"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-on"
          >
            <Trans>On</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="off"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-off"
          >
            <Trans>Off</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        onSuccess={() => setAuthModalOpen(false)}
        // Both affordances that open this modal are expired/signed-out
        // recoveries (probe-401 "sign in again" and the signed-out reconnect),
        // never a first connection — title accordingly.
        reauth
      />
    </section>
  );
}
