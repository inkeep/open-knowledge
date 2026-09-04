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
  useEffect(() => {
    if (consumeSyncAdvancedIntent()) setAdvancedOpen(true);
  }, []);
  const intervals = resolveAutoSyncIntervals(projectLocalConfig?.autoSync);
  const pushOutpacesPull = intervals.pushIntervalSeconds < intervals.pullIntervalSeconds;
  const localMode = resolveLocalAutoSyncMode(projectLocalConfig?.autoSync) ?? 'off';
  const { confirmOpen, setConfirmOpen, pendingMode, onModeSelect, onConfirm } =
    useSyncModeSelection(modeWriter, localMode);
  const [publishOpen, setPublishOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

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

  const modeControlDisabled = !projectLocalSynced;
  const isPushDenied =
    status?.pushPermission?.checkStatus === 'denied' ||
    status?.pausedReason === 'no-push-permission';
  const offerReconnect = shouldOfferReconnect(status?.pushPermission);
  const notFoundAsIdentity = status !== null && hasNotFoundAsIdentityError(status);
  const showReconnect = localMode === 'full' && isPushDenied && offerReconnect;
  const showSwitchToPullOnly =
    localMode === 'full' && isPushDenied && !offerReconnect && !notFoundAsIdentity;
  const showDeniedHint =
    !showSwitchToPullOnly && !showReconnect && isPushDenied && !notFoundAsIdentity;
  const genuineReadOnlyDenied =
    status?.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason !== 'not-authenticated' &&
    !notFoundAsIdentity;
  const isSignedOut =
    status?.pushPermission?.checkStatus === 'denied' &&
    status.pushPermission.deniedReason === 'not-authenticated';
  const parkedOnNotFound = isParkedOnNotFoundAsIdentity(status);
  const pausedNotice = !status?.pausedReason
    ? null
    : parkedOnNotFound
      ? formatSyncFailureCode('auth-not-found-as-identity')
      : isPushDenied
        ? null
        : formatPausedReason(status.pausedReason);

  function onModeChange(next: string) {
    if (!isSyncMode(next)) return;
    onModeSelect(next);
  }

  const committedDefaultValue = modeFromCommittedDefault(projectConfig?.autoSync?.default) ?? 'ask';
  function onCommittedDefaultChange(next: string) {
    if (next !== 'ask' && !isSyncMode(next)) return;
    if (defaultWriter === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
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
        return t`${seconds} seconds`;
    }
  }

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
                  {}
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
        {}
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
      {}
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
          {}
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
        reauth
      />
    </section>
  );
}
