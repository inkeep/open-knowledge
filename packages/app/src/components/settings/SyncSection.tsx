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
  resolveAutoSyncIntervals,
  resolveLocalAutoSyncMode,
  SYNC_INTERVAL_PRESET_SECONDS,
  type SyncMode,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AuthModal } from '@/components/AuthModal';
import { EnableSyncConfirmDialog } from '@/components/EnableSyncConfirmDialog';
import { PublishToGitHubDialog } from '@/components/PublishToGitHubDialog';
import {
  formatDeniedIdentitySentences,
  formatPausedReason,
  formatSyncFailureCode,
  hasNotFoundAsIdentityError,
  isParkedOnNotFoundAsIdentity,
  shouldOfferReconnect,
  shouldOfferSignInAgain,
} from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useSyncDefaultWriter,
  useSyncIntervalWriter,
  useSyncModeSelection,
  useSyncModeWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import { consumeSyncAdvancedIntent } from '@/lib/use-settings-route';
import { ScopeBadge } from './ScopeBadge';
import { SettingsSectionHeader } from './SettingsSectionHeader';

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
  const intervalWriter = useSyncIntervalWriter();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Consumed in an EFFECT, not a `useState` initializer. `consumeSyncAdvancedIntent`
  // mutates module state, and render must stay pure: React may call a component
  // (and its state initializers) more times than it commits — StrictMode does so
  // today, and a discarded or restarted render would silently swallow the intent
  // under future concurrent behavior. An effect runs after commit, so the flag is
  // consumed exactly as many times as the component actually mounts; its own
  // StrictMode double-run re-reads an already-cleared flag and no-ops.
  //
  // Not a bug fix — today both spellings open the disclosure. Measured on React
  // 19.2: StrictMode invokes the initializer twice but commits the FIRST call's
  // value, so the burned flag never reaches the committed state. This is about
  // not depending on that.
  //
  // This section renders only while `sync` is the active settings id, so the
  // consume fires exactly when the user lands on Sync — never on some other
  // section that happens to mount first.
  useEffect(() => {
    if (consumeSyncAdvancedIntent()) setAdvancedOpen(true);
  }, []);
  // Absent leaves resolve to the shipped 30 s / 60 s, so a project whose config
  // predates these keys shows today's cadence rather than an empty control.
  const intervals = resolveAutoSyncIntervals(projectLocalConfig?.autoSync);
  // Pushing faster than you pull leaves each push to discover the remote moved
  // and reconcile before it can land. Stated, not prevented: on a repo nobody
  // else writes to, the same setting is free, and clamping would forbid it.
  const pushOutpacesPull = intervals.pushIntervalSeconds < intervals.pullIntervalSeconds;
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
        <SettingsSectionHeader
          titleId="settings-sync-title"
          title={<Trans>Sync</Trans>}
          scope="project-local"
          level="block"
        >
          <Trans>
            This project lives only on this computer. Connect it to GitHub to back it up and share
            it with other people.
          </Trans>
        </SettingsSectionHeader>
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
  // The not-found masquerade suppresses every permission-flavored affordance
  // below: the failure is "repo missing or invisible to the account used",
  // not a collaborator-permission verdict, and Follow is no way out — an
  // account that can't see the repo can't fetch it either.
  const notFoundAsIdentity = status !== null && hasNotFoundAsIdentityError(status);
  const showReconnect = localMode === 'full' && isPushDenied && offerReconnect;
  const showSwitchToPullOnly =
    localMode === 'full' && isPushDenied && !offerReconnect && !notFoundAsIdentity;
  // The plain-text reason a push is denied. Deliberately carries NO `localMode`
  // term: it is the only channel that reaches a keyboard user, because Radix
  // drops a disabled toggle item from the roving tab order and the tooltip
  // hangs off a non-focusable wrapper. Gating it on mode left a read-only
  // collaborator already in Follow with no explanation anywhere.
  const showDeniedHint =
    !showSwitchToPullOnly && !showReconnect && isPushDenied && !notFoundAsIdentity;
  // Full sync would immediately fail-and-pause for a genuine read-only user, so
  // don't offer it. Signed-out denial is excluded — that user may well have push
  // access once they authenticate, so Full stays reachable for them. The
  // masquerade is excluded too: its probe also answers `denied`, but greying
  // Full out behind permission copy would state a cause the 404 doesn't prove
  // — and it would single out Full when Follow fetches the same unseeable
  // repo, implying a mode choice can rescue this.
  const genuineReadOnlyDenied =
    status?.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated' &&
    !notFoundAsIdentity;
  // No credentials at all — the same condition the server resolves as the
  // anonymous pull tier, which floors this machine's pull cadence. Used only to
  // caption the interval control, so a proxy off the push probe is enough; the
  // tier itself is resolved server-side and not carried in the status payload.
  const isSignedOut =
    status?.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason === 'not-authenticated';
  // The masquerade parks as auth-error, whose paused label reads "Reconnect
  // required" — the prescription every other surface withdraws for it — so it
  // shows the failure's own copy instead. Keyed on the same (pausedReason,
  // error-code) pair the badge uses, not on the code alone: a different pause
  // reason carrying a stale not-found code would otherwise make Settings and
  // the badge describe one status object differently. It wins over the
  // push-denied suppression below, since the probe against an unseeable repo
  // also answers `denied` and would otherwise leave only permission copy.
  // Shared with the badge so the two surfaces cannot drift apart.
  const parkedOnNotFound = isParkedOnNotFoundAsIdentity(status);
  // Otherwise a non-permission pause reason (protected-branch, dirty-tree, …),
  // reachable only under full sync — suppressed while a push-denied affordance
  // already explains the paused engine (`showSwitchToPullOnly` is a strict
  // refinement of `isPushDenied`, so testing the latter covers both).
  const pausedNotice = !status?.pausedReason
    ? null
    : parkedOnNotFound
      ? formatSyncFailureCode('auth-not-found-as-identity')
      : isPushDenied
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
    // OK build still honors them verbatim; 'follow' has no legacy equivalent, so
    // it is written as the mode string (older builds safely re-prompt on it).
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

  /**
   * Preset labels. A switch over the fixed preset list rather than a plural
   * macro: five known values give translators five natural strings instead of
   * a unit-plus-number template that reads awkwardly in several locales.
   */
  function intervalLabel(seconds: number): string {
    switch (seconds) {
      case 30:
        return t`30 seconds`;
      case 60:
        return t`1 minute`;
      case 300:
        return t`5 minutes`;
      case 900:
        return t`15 minutes`;
      case 3600:
        return t`1 hour`;
      default:
        // Reached via `intervalOptions` when a hand-edited config carries an
        // off-preset value (the schema admits any integer in range). Showing
        // the raw number keeps the control honest instead of snapping the
        // display to a preset the file does not say.
        return t`${seconds} seconds`;
    }
  }

  /**
   * The presets, plus the stored value when it is off-preset. Without the
   * extra entry a hand-edited `pullIntervalSeconds: 45` matched no item, and
   * Radix fills the trigger by portaling the SELECTED item's text — no item,
   * no text: a blank control with no indication of the cadence in effect,
   * where touching the other leg would silently rewrite this one.
   */
  function intervalOptions(current: number): number[] {
    return (SYNC_INTERVAL_PRESET_SECONDS as readonly number[]).includes(current)
      ? [...SYNC_INTERVAL_PRESET_SECONDS]
      : [...SYNC_INTERVAL_PRESET_SECONDS, current].sort((a, b) => a - b);
  }

  function onIntervalChange(leg: 'pull' | 'push', raw: string): void {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || intervalWriter === null) return;
    const result = intervalWriter({
      pullIntervalSeconds: leg === 'pull' ? seconds : intervals.pullIntervalSeconds,
      pushIntervalSeconds: leg === 'push' ? seconds : intervals.pushIntervalSeconds,
    });
    if (!result.ok) {
      const detail = result.error;
      toast.error(t`Failed to update the sync interval — ${detail}`);
    }
  }

  return (
    <section aria-labelledby="settings-sync-title" className="space-y-3">
      <SettingsSectionHeader
        titleId="settings-sync-title"
        title={<Trans>Sync</Trans>}
        scope="project-local"
        level="block"
      >
        <Trans>
          Keep this project in sync with your git remote. Auto (Pull only) brings in updates without
          pushing; Auto (Pull and Push) sends your edits too. Turning auto-sync on requires
          confirmation.
        </Trans>
      </SettingsSectionHeader>
      <div className="rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div id="settings-sync-mode-label" className="text-sm font-medium">
              <Trans>Git sync</Trans>
            </div>
            <p className="text-muted-foreground text-1sm" data-testid="settings-sync-body">
              {localMode === 'full' ? (
                <Trans>Your edits are committed and pushed to your remote automatically.</Trans>
              ) : localMode === 'follow' ? (
                <Trans>Updates flow in from your remote; your edits stay on this computer.</Trans>
              ) : (
                // Manual is a resting mode with in-app actions, not a dead end —
                // the old "until you commit and push manually" implied a terminal.
                <Trans>Nothing moves until you ask — pull and push from the sync menu.</Trans>
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
              <Trans>Manual</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="follow"
              className={SYNC_SELECTED_TOGGLE_CLASS}
              data-testid="settings-sync-mode-follow"
            >
              <Trans>Auto (Pull only)</Trans>
            </ToggleGroupItem>
            {genuineReadOnlyDenied ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button emits no pointer events, so the tooltip
                      hangs off a wrapper span that still receives hover. Radix
                      also drops a disabled item from the roving tab order, so
                      the tooltip is pointer-only — `aria-describedby` points
                      at the plain-text reason below so it reaches assistive
                      tech regardless of which siblings render. */}
                  <span className="inline-flex">
                    <ToggleGroupItem
                      value="full"
                      className={SYNC_SELECTED_TOGGLE_CLASS}
                      disabled
                      aria-describedby={
                        showDeniedHint ? 'settings-sync-denied-hint-text' : undefined
                      }
                      data-testid="settings-sync-mode-full"
                    >
                      <Trans>Auto (Pull and Push)</Trans>
                    </ToggleGroupItem>
                  </span>
                </TooltipTrigger>
                <TooltipContent data-testid="settings-sync-mode-full-tip">
                  <Trans>You don't have permission to push to this repo.</Trans>
                </TooltipContent>
              </Tooltip>
            ) : (
              <ToggleGroupItem
                value="full"
                className={SYNC_SELECTED_TOGGLE_CLASS}
                data-testid="settings-sync-mode-full"
              >
                <Trans>Auto (Pull and Push)</Trans>
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
                Auto-sync is paused — you don't have permission to push to this repo. Switch to Auto
                (Pull only) to keep receiving updates.
              </Trans>
            </p>
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => onModeSelect('follow')}
              data-testid="settings-sync-switch-follow-action"
            >
              <Trans>Switch to Auto (Pull only)</Trans>
            </Button>
          </div>
        )}
        {showDeniedHint && (
          // Suppressed for the signed-out shape — permission is unknowable
          // until they sign in — and for the not-found masquerade, where
          // Follow fails on the same invisible repo. The `id` is what the
          // disabled Full item points at via `aria-describedby`, so the reason
          // travels with the control instead of depending on siblings.
          <p
            id="settings-sync-denied-hint-text"
            className="text-1sm text-muted-foreground mt-2"
            data-testid="settings-sync-denied-hint"
          >
            {localMode === 'follow' ? (
              <Trans>You don't have permission to push to this repo.</Trans>
            ) : (
              <Trans>
                You don't have permission to push to this repo. Auto (Pull only) can still keep your
                copy up to date.
              </Trans>
            )}
          </p>
        )}
        {pausedNotice !== null && (
          <p className="text-1sm text-muted-foreground mt-2" data-testid="settings-sync-reason">
            {pausedNotice}
          </p>
        )}
        {/* A notice naming an account problem must name the account. Gated on
            any denial that produced a notice above, not just the masquerade:
            the badge appends the same tail after EVERY denial reason, on the
            grounds that a read-only verdict is exactly as account-dependent
            as a private-repo 404. One testid on the wrapper — the tail is up
            to two sentences (the account used, and the declared-account
            miss), which is the shape this feature exists to surface. */}
        {status?.pushPermission?.checkStatus === 'denied' &&
        (parkedOnNotFound || showSwitchToPullOnly || showDeniedHint) ? (
          <div className="mt-2 space-y-1" data-testid="settings-sync-identity">
            {formatDeniedIdentitySentences(status.pushPermission).map((sentence) => (
              <p key={sentence} className="text-1sm text-muted-foreground">
                {sentence}
              </p>
            ))}
          </div>
        ) : null}
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
      {/* Cadence is meaningless in Manual — nothing is scheduled — so the card
          is absent rather than disabled: a greyed control implies the setting
          applies here and is merely blocked. */}
      {localMode !== 'off' && (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="group gap-1 px-1.5 text-muted-foreground"
              data-testid="settings-sync-advanced-trigger"
            >
              <ChevronRight
                className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
              <Trans>Advanced</Trans>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <div className="rounded-md border p-3 space-y-3" data-testid="settings-sync-intervals">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div id="settings-sync-pull-interval-label" className="text-sm font-medium">
                    <Trans>Check for updates every</Trans>
                  </div>
                  <p className="text-muted-foreground text-1sm">
                    <Trans>How often this computer pulls changes from your remote.</Trans>
                  </p>
                </div>
                <Select
                  value={String(intervals.pullIntervalSeconds)}
                  onValueChange={(v) => onIntervalChange('pull', v)}
                  disabled={!projectLocalSynced}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-40 shrink-0"
                    aria-labelledby="settings-sync-pull-interval-label"
                    data-testid="settings-sync-pull-interval"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {intervalOptions(intervals.pullIntervalSeconds).map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {intervalLabel(seconds)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isSignedOut && (
                // The anonymous pull floor is enforced server-side, so a signed-out
                // follower who picks 30 s silently keeps polling at the floor. Say so
                // rather than letting the control claim a cadence it will not get.
                <p
                  className="text-1sm text-muted-foreground"
                  data-testid="settings-sync-anon-floor-hint"
                >
                  <Trans>
                    While you're signed out, updates are checked at most every 3 minutes regardless
                    of this setting.
                  </Trans>
                </p>
              )}
              {localMode === 'full' && (
                <div className="flex items-start justify-between gap-4 border-t pt-3">
                  <div className="min-w-0 flex-1">
                    <div id="settings-sync-push-interval-label" className="text-sm font-medium">
                      <Trans>Push my edits every</Trans>
                    </div>
                    <p className="text-muted-foreground text-1sm">
                      <Trans>Each push is one commit to your remote.</Trans>
                    </p>
                  </div>
                  <Select
                    value={String(intervals.pushIntervalSeconds)}
                    onValueChange={(v) => onIntervalChange('push', v)}
                    disabled={!projectLocalSynced}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-40 shrink-0"
                      aria-labelledby="settings-sync-push-interval-label"
                      data-testid="settings-sync-push-interval"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {intervalOptions(intervals.pushIntervalSeconds).map((seconds) => (
                        <SelectItem key={seconds} value={String(seconds)}>
                          {intervalLabel(seconds)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {localMode === 'full' && pushOutpacesPull && (
                <p
                  className="text-1sm text-muted-foreground"
                  data-testid="settings-sync-push-outpaces-pull-hint"
                >
                  <Trans>
                    You're pushing more often than you check for updates. If others write to this
                    repo too, pushes will often have to pull and try again.
                  </Trans>
                </p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="rounded-md border p-3 space-y-2" data-testid="settings-sync-default">
        <div className="space-y-0.5">
          {/* The block heading is per-machine, but this one control is committed.
              Same split as Terminal's auto-approve toggle: the control that
              breaks its heading's scope states its own. */}
          <div className="flex items-center gap-2">
            <div id="settings-sync-default-label" className="text-sm font-medium">
              <Trans>Shared default</Trans>
            </div>
            <ScopeBadge scope="project" />
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
            <Trans>Manual</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="follow"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-follow"
          >
            <Trans>Auto (Pull only)</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="full"
            className={SYNC_SELECTED_TOGGLE_CLASS}
            data-testid="settings-sync-default-full"
          >
            <Trans>Auto (Pull and Push)</Trans>
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
