/**
 * Sync section — the Settings home for the three-way sync mode
 * (off / pull-only / full) plus the committed shared default, so users have a
 * deliberate path to change modes even when the header badge is hidden
 * (state === 'disabled' hides the badge for non-following projects).
 *
 * The mode control writes through the project-local ConfigBinding so the
 * choice lands in `<projectDir>/.ok/local/config.yml`; the file watcher then
 * drives the SyncEngine to match.
 */

import {
  isSyncMode,
  modeFromCommittedDefault,
  resolveLocalAutoSyncMode,
  type SyncMode,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AuthModal } from '@/components/AuthModal';
import { EnableSyncConfirmDialog } from '@/components/EnableSyncConfirmDialog';
import { PublishToGitHubDialog } from '@/components/PublishToGitHubDialog';
import {
  formatPausedReason,
  shouldOfferReconnect,
  shouldOfferSignInAgain,
} from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useSyncDefaultWriter,
  useSyncModeSelection,
  useSyncModeWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';

// Selected toggle items use the app's primary blue (the same token as the
// Button default variant), not the muted ToggleGroup default, so the active
// stance reads as clearly chosen and matches the accent used elsewhere.
const SYNC_SELECTED_TOGGLE_CLASS =
  'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

export function SyncSection() {
  const { t } = useLingui();
  const status = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();
  const modeWriter = useSyncModeWriter();
  const defaultWriter = useSyncDefaultWriter();
  // Per-machine mode: an explicit `autoSync.mode` wins, else derive from the
  // legacy `enabled` boolean; never-answered resolves to off for display (the
  // committed shared default has its own control below).
  const localMode = resolveLocalAutoSyncMode(projectLocalConfig?.autoSync) ?? 'off';
  const { confirmOpen, setConfirmOpen, pendingMode, onModeSelect, onConfirm } =
    useSyncModeSelection(modeWriter, localMode);
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

  // Cold-start guard only: disable the control until the project-local config
  // has hydrated. Unlike the old boolean toggle, a denied probe does NOT disable
  // it — pull-only never pushes, so a push-denied receiver must still be able to
  // select it (the whole point of the mode).
  const modeControlDisabled = !projectLocalSynced;
  // Full sync paused (or would pause) because the push probe came back denied.
  // Only `full` cares about push permission — `pull`/`off` never push.
  const isPushDenied =
    status?.pushPermission?.checkStatus === 'denied' ||
    status?.pausedReason === 'no-push-permission';
  // Signed-out denial ('denied/not-authenticated') — signing back in restores
  // the full sync the user already consented to, so it takes precedence over
  // the switch-to-pull-only offer (that one is for genuinely revoked access).
  const offerReconnect = shouldOfferReconnect(status?.pushPermission);
  const showReconnect = localMode === 'full' && isPushDenied && offerReconnect;
  const showSwitchToPullOnly = localMode === 'full' && isPushDenied && !offerReconnect;
  // Full sync would immediately fail-and-pause for a genuine read-only user, so
  // don't offer it. Signed-out denial is excluded — that user may well have push
  // access once they authenticate, so Full stays reachable for them.
  const genuineReadOnlyDenied =
    status?.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated';
  // A non-permission pause reason (protected-branch, dirty-tree, …) — reachable
  // only under full sync. Suppressed when the switch-to-pull-only affordance
  // already explains a paused full-sync engine.
  const pausedNotice =
    showSwitchToPullOnly || isPushDenied || !status?.pausedReason
      ? null
      : formatPausedReason(status.pausedReason);

  function onModeChange(next: string) {
    // Radix single ToggleGroup emits '' when the active item is re-pressed
    // (deselect) — ignore so there is always exactly one selected mode.
    if (!isSyncMode(next)) return;
    onModeSelect(next);
  }

  // Committed project default (`autoSync.default`) — the maintainer-facing,
  // git-shared seed for everyone's first open. Widened to the mode vocabulary so
  // a maintainer can ship a pull-only default; `modeFromCommittedDefault` reads
  // both the mode strings and the legacy boolean seed, `null` (ask) = no seed.
  const committedDefaultValue = modeFromCommittedDefault(projectConfig?.autoSync?.default) ?? 'ask';
  function onCommittedDefaultChange(next: string) {
    // Radix single ToggleGroup emits '' when the active item is re-pressed
    // (deselect) — ignore it so there is always exactly one committed stance.
    if (next !== 'ask' && !isSyncMode(next)) return;
    if (defaultWriter === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
    // 'ask' clears the committed key (RFC 7396 merge-patch) → unanswered machines
    // see the onboarding prompt again. off/full stay legacy booleans so an older
    // OK build still honors them verbatim; 'pull' has no legacy equivalent, so it
    // is written as the mode string (older builds safely re-prompt on it).
    // Exhaustive per value: this writes committed (git-shared) config, so a
    // future mode must make a deliberate serialization choice here rather than
    // silently falling through to one arm.
    let value: boolean | SyncMode | null;
    switch (next) {
      case 'ask':
        value = null;
        break;
      case 'off':
        value = false;
        break;
      case 'full':
        value = true;
        break;
      case 'follow':
        value = 'follow';
        break;
      default: {
        const exhaustive: never = next;
        throw new Error(`unhandled committed default: ${String(exhaustive)}`);
      }
    }
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
            Keep this project in sync with your git remote. Follow fetches updates without pushing;
            full sync pushes your commits too. Turning sync on requires confirmation.
          </Trans>
        </p>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div id="settings-sync-mode-label" className="text-sm font-medium">
              <Trans>Git sync</Trans>
            </div>
            <p className="text-muted-foreground text-1sm" data-testid="settings-sync-body">
              {localMode === 'full' ? (
                <Trans>Full sync — your commits push and remote changes pull automatically.</Trans>
              ) : localMode === 'follow' ? (
                <Trans>
                  Follow — updates flow in from your remote; your edits stay on this computer.
                </Trans>
              ) : (
                <Trans>
                  Sync is off — your edits stay on this computer until you commit and push manually.
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
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            value={localMode}
            onValueChange={onModeChange}
            disabled={modeControlDisabled}
            aria-labelledby="settings-sync-mode-label"
            data-testid="settings-sync-mode-toggle"
          >
            <ToggleGroupItem
              value="off"
              className={SYNC_SELECTED_TOGGLE_CLASS}
              data-testid="settings-sync-mode-off"
            >
              <Trans>Off</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="follow"
              className={SYNC_SELECTED_TOGGLE_CLASS}
              data-testid="settings-sync-mode-follow"
            >
              <Trans>Follow</Trans>
            </ToggleGroupItem>
            {genuineReadOnlyDenied ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button emits no pointer events, so the tooltip
                      hangs off a wrapper span that still receives hover — the
                      only way to surface why Full is greyed out. Keyboard users
                      get the same reason from the read-only hint text below. */}
                  <span className="inline-flex">
                    <ToggleGroupItem
                      value="full"
                      className={SYNC_SELECTED_TOGGLE_CLASS}
                      disabled
                      data-testid="settings-sync-mode-full"
                    >
                      <Trans>Full</Trans>
                    </ToggleGroupItem>
                  </span>
                </TooltipTrigger>
                <TooltipContent data-testid="settings-sync-mode-full-tip">
                  <Trans>You don't have permission to push to this repo</Trans>
                </TooltipContent>
              </Tooltip>
            ) : (
              <ToggleGroupItem
                value="full"
                className={SYNC_SELECTED_TOGGLE_CLASS}
                data-testid="settings-sync-mode-full"
              >
                <Trans>Full</Trans>
              </ToggleGroupItem>
            )}
          </ToggleGroup>
        </div>
        {showReconnect && (
          // "Paused", not "off": the preference is still full sync, it's just
          // blocked by a signed-out session — reconnecting resumes it. Mirrors
          // the popover's reconnect affordance.
          <div className="mt-2 flex items-start gap-2" data-testid="settings-sync-reconnect">
            <p className="text-1sm text-muted-foreground flex-1 min-w-0">
              <Trans>Auto-sync is paused — sign in to resume.</Trans>
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
        {showSwitchToPullOnly && (
          <div className="mt-2 flex items-start gap-2" data-testid="settings-sync-switch-follow">
            <p className="text-1sm text-muted-foreground flex-1 min-w-0">
              <Trans>
                Auto-sync is paused — you don't have permission to push to this repo. Switch to
                Follow to keep receiving updates.
              </Trans>
            </p>
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => onModeSelect('follow')}
              data-testid="settings-sync-switch-follow-action"
            >
              <Trans>Switch to Follow</Trans>
            </Button>
          </div>
        )}
        {!showSwitchToPullOnly && !showReconnect && isPushDenied && localMode !== 'follow' && (
          // Push-denied and not yet following: point the receiver at pull-only,
          // which the mode control above already offers. Suppressed for the
          // signed-out shape — permission is unknowable until they sign in.
          <p
            className="text-1sm text-muted-foreground mt-2"
            data-testid="settings-sync-denied-hint"
          >
            <Trans>
              You don't have permission to push to this repo. Follow can still keep your copy up to
              date.
            </Trans>
          </p>
        )}
        {pausedNotice !== null && (
          <p className="text-1sm text-muted-foreground mt-2" data-testid="settings-sync-reason">
            {pausedNotice}
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
      </div>
      <div className="rounded-md border p-3 space-y-2" data-testid="settings-sync-default">
        <div className="space-y-0.5">
          <div id="settings-sync-default-label" className="text-sm font-medium">
            <Trans>Shared default</Trans>
          </div>
          <p className="text-muted-foreground text-1sm">
            <Trans>
              Set the sync default for users opening this project for the first time. This setting
              is committed to your repository.
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
          aria-labelledby="settings-sync-default-label"
          data-testid="settings-sync-default-toggle"
        >
          <ToggleGroupItem
            value="ask"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-ask"
          >
            <Trans>None</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="off"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-off"
          >
            <Trans>Off</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="follow"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-follow"
          >
            <Trans>Follow</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="full"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-full"
          >
            <Trans>Full</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
        variant={pendingMode ?? 'full'}
        strandedCommitCount={pendingMode === 'follow' ? (status?.ahead ?? 0) : 0}
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
