import { parseManagedArtifactName } from '@inkeep/open-knowledge-core/constants/cc1';
import { APP_HEADER_HEIGHT } from '@inkeep/open-knowledge-core/constants/chrome';
import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { shouldShowAppMenubar } from '@/components/app-menubar-gate';
import { BetaBadge } from '@/components/BetaBadge';
import {
  HEADER_OVERFLOW_SLACK_PX,
  HeaderOverflowActions,
} from '@/components/HeaderOverflowActions';
import { HeaderPaneButtons, useHeaderPaneButtonSet } from '@/components/HeaderPaneButtons';
import { HeaderSearchBar, onPillRenderError } from '@/components/HeaderSearchBar';
import { HelpPopover } from '@/components/HelpPopover';
import { InstanceBadge } from '@/components/InstanceBadge';
import { NavigationHistoryControls } from '@/components/NavigationHistoryControls';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { PublishToGitHubDialog } from '@/components/PublishToGitHubDialog';
import { SettingsButton } from '@/components/SettingsButton';
import { ShareButton } from '@/components/ShareButton';
import { displayState, SyncStatusBadge } from '@/components/SyncStatusBadge';
import { WebProjectName } from '@/components/WebProjectName';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useTrailingOverflow } from '@/hooks/use-trailing-overflow';
import { authPromptStore } from '@/lib/auth-prompt-store';
import {
  buildDocShareInput,
  buildFolderShareInput,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { PresenceBar } from '@/presence/PresenceBar';
import { SyncToastHost } from '@/presence/SyncToastHost';

const AppMenubar = lazy(() =>
  import('@/components/AppMenubar').then((m) => ({ default: m.AppMenubar })),
);

export { APP_HEADER_HEIGHT };

function centreNaturalWidth(centre: HTMLElement): number {
  let width = 0;
  for (const child of centre.children) {
    if (child instanceof HTMLElement) width += child.offsetWidth;
  }
  if (centre.clientWidth > width + 1) return width;
  for (const label of centre.querySelectorAll<HTMLElement>('[data-app-header-center-label]')) {
    width += Math.max(0, label.scrollWidth - label.clientWidth);
  }
  return width;
}

function hiddenInstanceBadgeLabelWidth(leading: HTMLElement): number {
  const label = leading.querySelector<HTMLElement>('[data-instance-badge-label]');
  const badge = label?.parentElement;
  if (!label || !badge) return 0;
  const maxWidth = Number.parseFloat(getComputedStyle(label).maxWidth);
  const natural = Number.isFinite(maxWidth)
    ? Math.min(label.scrollWidth, maxWidth)
    : label.scrollWidth;
  return natural + (Number.parseFloat(getComputedStyle(badge).columnGap) || 0);
}

function leadingBadgesWidth(leading: HTMLElement): number | null {
  const badges = leading.querySelector<HTMLElement>('[data-app-header-badges]');
  if (!badges) return null;
  if (badges.offsetWidth <= 0) return 0;
  return badges.offsetWidth + (Number.parseFloat(getComputedStyle(leading).columnGap) || 0);
}

function AppHeaderBadges({
  compact,
  isElectronHost,
}: {
  compact: boolean;
  isElectronHost: boolean;
}) {
  return (
    <div data-app-header-badges="" className="flex items-center gap-1 empty:hidden">
      <BetaBadge />
      <InstanceBadge
        compact={compact}
        className={cn(isElectronHost && '[-webkit-app-region:no-drag]')}
      />
    </div>
  );
}

function centreFloorWidth(centre: HTMLElement): number {
  let width = 0;
  for (const child of centre.children) {
    if (child instanceof HTMLElement) width += child.offsetWidth;
  }
  for (const label of centre.querySelectorAll<HTMLElement>('[data-app-header-center-label]')) {
    width -= label.offsetWidth;
  }
  return Math.max(0, width);
}

interface AppHeaderProps {
  onOpenSearch: () => void;
}

export function AppHeader({ onOpenSearch }: AppHeaderProps) {
  const { t } = useLingui();
  const singleFile = useSingleFileMode();
  const { activeDocName, activeTarget } = useDocumentContext();
  const desktopBridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const isElectronHost = desktopBridge != null;
  const foldsBadges = isElectronHost && desktopBridge.platform !== 'darwin';
  const [publishOpen, setPublishOpen] = useState(false);
  const [badgeCompact, setBadgeCompact] = useState(false);
  const badgeCompactRef = useRef(false);
  const leadingBadgesRef = useRef({ width: 0, labelWidth: 0, hasLabel: false });
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [leading, setLeading] = useState<HTMLDivElement | null>(null);
  const [trailing, setTrailing] = useState<HTMLDivElement | null>(null);
  const [centre, setCentre] = useState<HTMLDivElement | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);

  const shareInput: ShareTargetInput | null = singleFile
    ? null
    : (() => {
        if (activeTarget?.kind === 'folder') return buildFolderShareInput(activeTarget.folderPath);
        if (activeDocName && !parseManagedArtifactName(activeDocName)) {
          return buildDocShareInput(activeDocName);
        }
        if (!activeTarget && !activeDocName) return buildFolderShareInput('');
        return null;
      })();
  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const paneButtonSet = useHeaderPaneButtonSet();
  const trailingContentSignature = [
    String(shareInput != null),
    gitSyncStatus?.hasRemote ? displayState(gitSyncStatus) : 'no-remote',
    paneButtonSet.join(','),
  ].join('|');

  const actionsOverflowed = useTrailingOverflow({
    header,
    leading,
    trailing,
    centre,
    signature: trailingContentSignature,
    slack: HEADER_OVERFLOW_SLACK_PX,
    measureTrailingWidth: (elements) =>
      elements.trailing.offsetWidth +
      (Number.parseFloat(getComputedStyle(elements.trailing).marginInlineEnd) || 0),
    measureAvailableWidth: (elements, latchedTrailingWidth) => {
      const headerWidth = elements.header.offsetWidth;
      const badgesWidth = leadingBadgesWidth(elements.leading);
      if (badgesWidth !== null) {
        const labelWidth = hiddenInstanceBadgeLabelWidth(elements.leading);
        leadingBadgesRef.current = {
          width: badgesWidth + (badgeCompactRef.current ? labelWidth : 0),
          labelWidth,
          hasLabel: elements.leading.querySelector('[data-instance-badge-label]') != null,
        };
      }
      const badges = leadingBadgesRef.current;
      const leadingExpandedWidth =
        badgesWidth === null
          ? elements.leading.offsetWidth + badges.width
          : elements.leading.offsetWidth + (badgeCompactRef.current ? badges.labelWidth : 0);
      const compact =
        centre != null &&
        badges.hasLabel &&
        leadingExpandedWidth +
          centreNaturalWidth(centre) +
          latchedTrailingWidth +
          HEADER_OVERFLOW_SLACK_PX >
          headerWidth;
      badgeCompactRef.current = compact;
      setBadgeCompact(compact);
      const leadingSettledWidth = compact
        ? leadingExpandedWidth - badges.labelWidth
        : leadingExpandedWidth;
      return headerWidth - leadingSettledWidth - (centre != null ? centreFloorWidth(centre) : 0);
    },
  });
  const badgesFolded = (foldsBadges || singleFile) && actionsOverflowed;

  const trailingActions = (
    <>
      <PresenceBar />
      {!singleFile && (
        <ShareButton
          input={shareInput}
          onClickWhenNoRemote={() => setPublishOpen(true)}
          triggerRef={shareButtonRef}
        />
      )}
      <SyncStatusBadge
        onSignIn={() => authPromptStore.request('auth')}
        onSetIdentity={() => authPromptStore.request('identity')}
      />
      {!singleFile && <SettingsButton />}
      <HelpPopover />
    </>
  );

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: App mounts this header outside main, article and section, where it is the banner landmark and takes a name; the rule reads every header as generic.
    <header
      ref={setHeader}
      aria-label={t`Application`}
      data-app-header=""
      data-electron-drag={isElectronHost ? '' : undefined}
      className={cn(
        'grid h-[var(--ok-app-header-height,2.75rem)] w-full shrink-0 items-center',
        'grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] grid-rows-1',
        'bg-desk',
        isElectronHost &&
          '[-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]',
      )}
    >
      <div
        ref={setLeading}
        data-app-header-leading=""
        className="flex min-w-0 items-center gap-1 justify-self-start ps-[calc(var(--ok-titlebar-reserve-left,0px)+0.625rem)] rtl:ps-[calc(var(--ok-titlebar-reserve-right,0px)+0.625rem)]"
      >
        {shouldShowAppMenubar() && (
          <Suspense fallback={null}>
            <AppMenubar className="-ms-0.5" />
          </Suspense>
        )}
        {isElectronHost && !singleFile && <NavigationHistoryControls />}
        {!singleFile && (
          <ErrorBoundary
            fallbackRender={() => null}
            onError={onPillRenderError}
            resetKeys={[activeDocName]}
          >
            <HeaderSearchBar onClick={onOpenSearch} />
          </ErrorBoundary>
        )}
        {!badgesFolded && (
          <AppHeaderBadges compact={badgeCompact} isElectronHost={isElectronHost} />
        )}
      </div>
      <div
        ref={setCentre}
        data-app-header-center=""
        className="flex min-w-0 items-center justify-center"
      >
        {singleFile ? null : desktopBridge ? (
          <ProjectSwitcher bridge={desktopBridge} />
        ) : (
          <WebProjectName />
        )}
      </div>
      <div
        ref={setTrailing}
        data-app-header-trailing=""
        className={cn(
          'flex min-w-0 items-center justify-end gap-1 justify-self-end pe-2.5',
          '[&_[data-slot=presence-bar]]:px-0',
          isElectronHost &&
            'me-[var(--ok-titlebar-reserve-right,0px)] rtl:me-[var(--ok-titlebar-reserve-left,0px)]',
        )}
      >
        {actionsOverflowed ? (
          <HeaderOverflowActions syncStatus={gitSyncStatus} triggerRef={overflowTriggerRef}>
            {badgesFolded && <AppHeaderBadges compact={false} isElectronHost={isElectronHost} />}
            {trailingActions}
          </HeaderOverflowActions>
        ) : (
          trailingActions
        )}
        <HeaderPaneButtons />
        <SyncToastHost />
        {!singleFile && (
          <PublishToGitHubDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            returnFocus={() => (shareButtonRef.current ?? overflowTriggerRef.current)?.focus()}
          />
        )}
      </div>
    </header>
  );
}
