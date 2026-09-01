// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { parseManagedArtifactName } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { shouldShowAppMenubar } from '@/components/app-menubar-gate';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { isNoteWindow } from '@/lib/note-window-mode';
import {
  buildDocShareInput,
  buildFolderShareInput,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { PresenceBar } from '@/presence/PresenceBar';
import { BetaBadge } from './BetaBadge';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { HelpPopover } from './HelpPopover';
import { InstanceBadge } from './InstanceBadge';
import { NavigationHistoryControls } from './NavigationHistoryControls';
import { PublishToGitHubDialog } from './PublishToGitHubDialog';
import { SettingsButton } from './SettingsButton';
import { ShareButton } from './ShareButton';
import { SyncStatusBadge } from './SyncStatusBadge';

const AppMenubar = lazy(() =>
  import('@/components/AppMenubar').then((m) => ({ default: m.AppMenubar })),
);

interface EditorHeaderProps {
  children?: ReactNode;
  noteModeToggle?: ReactNode;
  onSignIn?: () => void;
  onSetIdentity?: () => void;
  onOpenSearch?: () => void;
}

export function EditorHeader({
  children,
  noteModeToggle,
  onSignIn,
  onSetIdentity,
  onOpenSearch,
}: EditorHeaderProps) {
  const { t } = useLingui();
  const { activeDocName, activeTarget } = useDocumentContext();
  const managedArtifact = activeDocName ? parseManagedArtifactName(activeDocName) : null;
  const { state: sidebarState } = useSidebar();
  const singleFile = useSingleFileMode();
  const noteWindow = isNoteWindow();
  const reducedChrome = singleFile || noteWindow;
  const sidebarShortcut = formatShortcut('toggle-files-sidebar');
  const sidebarShortcutLabel = formatShortcutLabel('toggle-files-sidebar');
  const searchShortcut = formatShortcut('command-palette');
  const searchShortcutLabel = formatShortcutLabel('command-palette');
  const [publishOpen, setPublishOpen] = useState(false);
  const [chromeMeasured, setChromeMeasured] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const leadingActionsRef = useRef<HTMLDivElement>(null);
  const tabsHostRef = useRef<HTMLDivElement>(null);
  const trailingActionsRef = useRef<HTMLDivElement>(null);
  const shareInput: ShareTargetInput | null = (() => {
    if (activeTarget?.kind === 'folder') {
      return buildFolderShareInput(activeTarget.folderPath);
    }
    if (activeDocName && !managedArtifact) {
      return buildDocShareInput(activeDocName);
    }
    if (!activeTarget && !activeDocName) {
      return buildFolderShareInput('');
    }
    return null;
  })();

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const isCollapsed = sidebarState === 'collapsed';
  const reserveTrafficLights = isElectronHost && (isCollapsed || noteWindow);
  const appMenubar = shouldShowAppMenubar() ? (
    <Suspense fallback={null}>
      <AppMenubar />
    </Suspense>
  ) : null;

  useLayoutEffect(() => {
    const header = headerRef.current;
    const leadingActions = leadingActionsRef.current;
    const tabsHost = tabsHostRef.current;
    const trailingActions = trailingActionsRef.current;
    if (!header || !leadingActions || !tabsHost || !trailingActions) return;

    const updateChromeWidths = () => {
      header.style.setProperty('--editor-header-leading-width', `${leadingActions.offsetWidth}px`);
      const trailingMargin = Number.parseFloat(getComputedStyle(trailingActions).marginRight) || 0;
      const rightRailWidth = Math.max(0, header.offsetWidth - tabsHost.offsetWidth);
      header.style.setProperty(
        '--editor-header-trailing-width',
        `${Math.max(0, trailingActions.offsetWidth + trailingMargin - rightRailWidth)}px`,
      );
    };
    updateChromeWidths();

    let revealFrame = requestAnimationFrame(() => {
      updateChromeWidths();
      revealFrame = requestAnimationFrame(() => {
        updateChromeWidths();
        setChromeMeasured(true);
      });
    });

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateChromeWidths);
    observer?.observe(header);
    observer?.observe(leadingActions);
    observer?.observe(tabsHost);
    observer?.observe(trailingActions);
    return () => {
      cancelAnimationFrame(revealFrame);
      observer?.disconnect();
    };
  }, []);

  const headerActions = (
    <>
      {}
      {!reducedChrome && (
        <ShareButton input={shareInput} onClickWhenNoRemote={() => setPublishOpen(true)} />
      )}
      {!noteWindow && <SyncStatusBadge onSignIn={onSignIn} onSetIdentity={onSetIdentity} />}
      <PresenceBar />
      <Separator orientation="vertical" className="h-4 shrink-0 data-vertical:self-center" />
      <InstanceBadge />
      <BetaBadge />
      {}
      {!reducedChrome && <SettingsButton />}
      {!noteWindow && <HelpPopover />}
    </>
  );

  return (
    <header
      ref={headerRef}
      data-electron-drag={isElectronHost ? '' : undefined}
      style={{
        ['--editor-header-leading-offset' as string]: reserveTrafficLights
          ? 'var(--ok-titlebar-reserve-left, 1rem)'
          : '0px',
      }}
      className={cn(
        'group/editor-header relative flex h-12 shrink-0 items-center',
        noteWindow ? 'bg-background' : 'bg-muted/35 shadow-[inset_0_-1px_0_var(--border)]',
        isElectronHost && '[-webkit-app-region:drag]',
      )}
    >
      {}
      <div
        ref={tabsHostRef}
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-tabs=""
        className={cn(
          'absolute inset-y-0 left-0 z-10 flex min-w-0 w-[var(--editor-header-tabs-width,100%)] overflow-hidden',
          !chromeMeasured && 'invisible',
          isElectronHost && '[-webkit-app-region:drag]',
        )}
      >
        {children}
      </div>

      {}
      <div
        ref={leadingActionsRef}
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-leading-actions=""
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex items-center gap-1 px-3',
          isElectronHost && '[-webkit-app-region:drag]',
          reserveTrafficLights && 'left-[var(--ok-titlebar-reserve-left,1rem)]',
          noteWindow && 'max-w-[calc(50%-4rem)] overflow-hidden',
        )}
      >
        {}
        {singleFile && appMenubar}
        {noteWindow && <EditorBreadcrumb docName={activeDocName} includeCurrentPage />}
        {!reducedChrome && (
          <>
            <ButtonGroup
              aria-label={t`Workspace navigation`}
              className="-ml-1 shrink-0 has-[>[data-slot=button-group]]:gap-0"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger
                    className={cn(
                      'shrink-0 text-muted-foreground',
                      isElectronHost && '[-webkit-app-region:no-drag]',
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <span>{sidebarState === 'expanded' ? t`Hide Files` : t`Show Files`}</span>{' '}
                  <Kbd aria-label={sidebarShortcutLabel}>{sidebarShortcut}</Kbd>
                </TooltipContent>
              </Tooltip>
              {isCollapsed && onOpenSearch && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={onOpenSearch}
                      aria-label={t`Search (${searchShortcutLabel})`}
                      data-telemetry-event="ok.editor_header.search.click"
                      className={cn(
                        'shrink-0 text-muted-foreground',
                        isElectronHost && '[-webkit-app-region:no-drag]',
                      )}
                    >
                      <Search aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>{t`Search`}</span>{' '}
                    <Kbd aria-label={searchShortcutLabel}>{searchShortcut}</Kbd>
                  </TooltipContent>
                </Tooltip>
              )}
              {isElectronHost && isCollapsed && <NavigationHistoryControls />}
            </ButtonGroup>
            {}
            {appMenubar}
            <Separator
              orientation="vertical"
              className="mr-1 h-4 shrink-0 data-vertical:self-center"
            />
          </>
        )}
      </div>

      {noteWindow && noteModeToggle ? (
        <div
          data-note-window-mode-toggle=""
          className="absolute inset-y-0 left-1/2 z-30 flex -translate-x-1/2 items-center [-webkit-app-region:no-drag] [&_[data-slot=toggle-group]]:bg-transparent [&_[data-slot=toggle-group]]:p-0 [&_[data-slot=toggle-group-item]]:size-8 [&_[data-slot=toggle-group-item]]:shadow-none"
        >
          {noteModeToggle}
        </div>
      ) : null}

      <div
        ref={trailingActionsRef}
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-actions=""
        className={cn(
          'absolute inset-y-0 right-0 z-20 flex items-center justify-end gap-2 px-3',
          isElectronHost &&
            '[-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_a]:[-webkit-app-region:no-drag]',
          isElectronHost && 'mr-[var(--ok-titlebar-reserve-right,0px)]',
        )}
      >
        {!noteWindow && headerActions}
        {!reducedChrome && (
          <PublishToGitHubDialog open={publishOpen} onOpenChange={setPublishOpen} />
        )}
      </div>
    </header>
  );
}
