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
import {
  buildDocShareInput,
  buildFolderShareInput,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { PresenceBar } from '@/presence/PresenceBar';
import { BetaBadge } from './BetaBadge';
import { HelpPopover } from './HelpPopover';
import { InstanceBadge } from './InstanceBadge';
import { NavigationHistoryControls } from './NavigationHistoryControls';
import { PublishToGitHubDialog } from './PublishToGitHubDialog';
import { SettingsButton } from './SettingsButton';
import { ShareButton } from './ShareButton';
import { SyncStatusBadge } from './SyncStatusBadge';

// Lazy: win/linux-only chrome — the chunk (component + radix Menubar
// primitive) must not ship in the eager bundle web + macOS load.
const AppMenubar = lazy(() =>
  import('@/components/AppMenubar').then((m) => ({ default: m.AppMenubar })),
);

interface EditorHeaderProps {
  children?: ReactNode;
  onSignIn?: () => void;
  onSetIdentity?: () => void;
  onOpenSearch?: () => void;
}

export function EditorHeader({
  children,
  onSignIn,
  onSetIdentity,
  onOpenSearch,
}: EditorHeaderProps) {
  const { t } = useLingui();
  const { activeDocName, activeTarget } = useDocumentContext();
  // Managed-artifact tabs (skills/templates) are ordinary docs but carry their
  // own header treatment: neither skills nor templates are shareable (the
  // synthetic doc name isn't a real on-disk path to share), so the ShareButton
  // trigger gates on this. The agent-handoff for a skill lives in the Skills
  // sidebar (SkillsSidebarSection / skill-actions), not the header.
  const managedArtifact = activeDocName ? parseManagedArtifactName(activeDocName) : null;
  const { state: sidebarState } = useSidebar();
  // No-project single-file session (`ok <file>`): drop the project chrome
  // (sidebar toggle, tab strip, Settings) while leaving the editor + the
  // doc-scoped actions (Share / sync / agent handoff) intact.
  const singleFile = useSingleFileMode();
  const sidebarShortcut = formatShortcut('toggle-files-sidebar');
  const sidebarShortcutLabel = formatShortcutLabel('toggle-files-sidebar');
  const searchShortcut = formatShortcut('command-palette');
  const searchShortcutLabel = formatShortcutLabel('command-palette');
  const [publishOpen, setPublishOpen] = useState(false);
  // Keep tabs hidden until their action-zone offsets are ready; otherwise
  // the zero-width CSS fallback is visible for one frame during startup.
  const [chromeMeasured, setChromeMeasured] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const leadingActionsRef = useRef<HTMLDivElement>(null);
  const tabsHostRef = useRef<HTMLDivElement>(null);
  const trailingActionsRef = useRef<HTMLDivElement>(null);
  // Share input for the header button: folder → folder-scope, doc → doc-scope,
  // empty editor → project root; non-shareable surfaces yield null (disabled).
  const shareInput: ShareTargetInput | null = (() => {
    if (activeTarget?.kind === 'folder') {
      return buildFolderShareInput(activeTarget.folderPath);
    }
    // Managed-artifact tabs aren't shareable — their synthetic doc name has no
    // shareable on-disk path.
    if (activeDocName && !managedArtifact) {
      return buildDocShareInput(activeDocName);
    }
    if (!activeTarget && !activeDocName) {
      return buildFolderShareInput('');
    }
    return null;
  })();

  // Electron host gates the macOS chrome-row treatment: a traffic-light
  // reserve at the inset position, plus a draggable header surface with
  // explicit no-drag opt-outs on every interactive child. Web hosts (CLI
  // distribution at `ok ui` localhost) keep the existing layout — no padding
  // shift, no drag region, no traffic-light reserve. Detection mirrors the
  // canonical idiom used in OpenInAgentMenu and FileTree.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  // Sidebar collapse drives the traffic-light reserve. When the sidebar is
  // expanded, the macOS traffic lights overlap the SIDEBAR (not the
  // EditorHeader), so the reserve is unnecessary and would push every
  // editor-header child uselessly to the right. When the sidebar collapses
  // offcanvas, the EditorHeader's left edge becomes the window's left edge
  // and the reserve is required to keep the SidebarTrigger clear of the
  // traffic lights. The reserve uses the shared `--ok-titlebar-reserve-left`
  // token (defined under `html.electron-mode`) so the magic 78px lives in one
  // place; the `,1rem` fallback is the precedent-#49 safe form.
  const isCollapsed = sidebarState === 'collapsed';
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
      const rightRailWidth = Math.max(0, header.offsetWidth - tabsHost.offsetWidth);
      header.style.setProperty(
        '--editor-header-trailing-width',
        `${Math.max(0, trailingActions.offsetWidth - rightRailWidth)}px`,
      );
    };
    updateChromeWidths();

    // Let both the header chrome and the restored tab workspace settle before
    // making the tabs visible. Revealing after the first measurement exposes
    // the zero-width fallback briefly, then moves the tabs when layout catches
    // up on the next frame.
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
      {/* Share is a project surface: single-file `ok <file>` runs agents/MCP
          off and on a throwaway server, so a share link would point at a
          session that's gone on close. Hidden here (mirrors the
          sidebar/Settings gates) rather than rendered disabled. */}
      {!singleFile && (
        <ShareButton input={shareInput} onClickWhenNoRemote={() => setPublishOpen(true)} />
      )}
      <SyncStatusBadge onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
      <PresenceBar />
      <Separator orientation="vertical" className="h-4 shrink-0 data-vertical:self-center" />
      <InstanceBadge />
      <BetaBadge />
      {/* Settings is unavailable in single-file mode (config editing is inert). */}
      {!singleFile && <SettingsButton />}
      <HelpPopover />
    </>
  );

  return (
    <header
      ref={headerRef}
      data-electron-drag={isElectronHost ? '' : undefined}
      style={{
        ['--editor-header-leading-offset' as string]:
          isElectronHost && isCollapsed ? 'var(--ok-titlebar-reserve-left, 1rem)' : '0px',
      }}
      className={cn(
        'group/editor-header relative flex h-12 shrink-0 items-center bg-muted/35 shadow-[inset_0_-1px_0_var(--border)]',
        isElectronHost && '[-webkit-app-region:drag]',
      )}
    >
      {/* The left zone (files toggle and search) is project chrome —
          empty in single-file mode. */}
      <div
        ref={leadingActionsRef}
        data-editor-header-leading-actions=""
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex items-center gap-1 px-3',
          isElectronHost && isCollapsed && 'left-[var(--ok-titlebar-reserve-left,1rem)]',
        )}
      >
        {/* The menubar renders in single-file windows too: the project-chrome
            group below is absent there, so without this slot Window / Help /
            Exit would have no reachable surface at all. */}
        {singleFile && appMenubar}
        {!singleFile && (
          <>
            <ButtonGroup
              aria-label={t`Workspace navigation`}
              className={cn(
                '-ml-1 shrink-0 has-[>[data-slot=button-group]]:gap-0',
                isElectronHost && '[-webkit-app-region:no-drag]',
              )}
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
            {/* Windows/Linux custom menubar follows the Files control in the
                chrome row; null on darwin + web. */}
            {appMenubar}
            <Separator
              orientation="vertical"
              className="mr-1 h-4 shrink-0 data-vertical:self-center"
            />
          </>
        )}
      </div>

      <div
        ref={tabsHostRef}
        data-editor-header-tabs=""
        className={cn(
          'absolute inset-y-0 left-0 z-10 flex min-w-0 w-[var(--editor-header-tabs-width,100%)] overflow-hidden',
          !chromeMeasured && 'invisible',
          isElectronHost && '[-webkit-app-region:no-drag]',
        )}
      >
        {children}
      </div>

      <div
        ref={trailingActionsRef}
        data-editor-header-actions=""
        className={cn(
          'absolute inset-y-0 right-0 z-20 flex items-center justify-end gap-2 px-3',
          // Child-combinator opt-out: every direct DOM child of the right zone
          // gets `app-region: no-drag` so clicks on Save / OpenInAgentMenu /
          // SyncStatusBadge / PresenceBar / BetaBadge / SettingsButton /
          // HelpPopover (and the visual Separator) fire their handlers instead
          // of initiating a window drag. Each consumer uses Radix asChild so
          // the rendered DOM root is a single direct child of this zone.
          isElectronHost && '*:[-webkit-app-region:no-drag]',
          // Windows/Linux: the OS window controls float over the top-right
          // of this row (titleBarOverlay). --ok-titlebar-reserve-right is
          // non-zero only under electron-platform-win32/linux (see
          // globals.css); the 0px fallback keeps darwin + web unchanged.
          isElectronHost && 'mr-[var(--ok-titlebar-reserve-right,0px)]',
        )}
      >
        {headerActions}
        {!singleFile && <PublishToGitHubDialog open={publishOpen} onOpenChange={setPublishOpen} />}
      </div>
    </header>
  );
}
