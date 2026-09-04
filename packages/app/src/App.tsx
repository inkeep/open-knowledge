import { mediaKindForSidebarAssetExtension, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CommentQueueShortcut } from '@/comments/CommentQueueShortcut';
import { BranchRecycleBanner } from '@/components/BranchRecycleBanner';
import { CommandPalette } from '@/components/CommandPalette';
import { ConnectingBanner } from '@/components/ConnectingBanner';
import { CreateProjectMenuTrigger } from '@/components/CreateProjectMenuTrigger';
import { EditorPane } from '@/components/EditorPane';
import { FeedbackMenuTrigger } from '@/components/FeedbackMenuTrigger';
import { FileSidebar } from '@/components/FileSidebar';
import { defaultInitialDir } from '@/components/file-tree-utils';
import {
  type TerminalLaunchContextValue,
  TerminalLaunchProvider,
} from '@/components/handoff/TerminalLaunchContext';
import { requestTerminalLaunch } from '@/components/handoff/terminal-launch-events';
import { composeTerminalLaunchPrompt } from '@/components/handoff/useHandoffDispatch';
import { InstallInClaudeDesktopDialog } from '@/components/InstallInClaudeDesktopDialog';
import { McpConsentDialog } from '@/components/McpConsentDialog';
import { isNewItemShortcut, NewItemDialog } from '@/components/NewItemDialog';
import { NoteWindowMainActionReceiver } from '@/components/NoteWindowMainActionReceiver';
import {
  downgradeFolderIndexForHashNav,
  type ResolvedNavigationTarget,
  resolveNavigationTarget,
  withLargeFileOpenGuard,
} from '@/components/navigation-targets';
import { PageListProvider, usePageList } from '@/components/PageListContext';
import { ReportBugMenuTrigger } from '@/components/ReportBugMenuTrigger';
import { SkillTrackInGitDialog } from '@/components/SkillTrackInGitDialog';
import { SystemDocSubscriber } from '@/components/SystemDocSubscriber';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ValidationFreshness } from '@/components/ValidationFreshness';
import { BackgroundThrottleReporter } from '@/editor/BackgroundThrottleReporter';
import {
  DocumentProvider,
  useDocumentContext,
  useDocumentTransition,
} from '@/editor/DocumentContext';
import { EditorLifecycleFlush } from '@/editor/EditorLifecycleFlush';
import { parseEditorTabId, tabIdForNavigationTarget } from '@/editor/editor-tabs';
import { previewOpenDisposition } from '@/editor/preview-open-disposition';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { useReconcileSkillTabs } from '@/hooks/use-reconcile-skill-tabs';
import { ConfigProvider, useConfigContext } from '@/lib/config-provider';
import { createPageRequest, nextUntitledDocName, openCreatedPage } from '@/lib/create-page-request';
import {
  assetPathFromHash,
  docNameFromHash,
  isContentRootHash,
  isManagedHashHistoryState,
  markCurrentHashHistoryEntry,
  replaceHashWithoutNavigation,
  skillFileFromHash,
  skillPreviewFromHash,
  skillsFromHash,
} from '@/lib/doc-hash';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { mark, ProfilerBoundary } from '@/lib/perf';
import { SingleFileModeProvider, useSingleFileMode } from '@/lib/single-file-mode';
import { consumeHashNavigationSuppression } from '@/lib/tab-session-restore-suppression';
import { useServerKeepalive } from '@/lib/use-server-keepalive';
import {
  isSettingsHashOpen,
  isSettingsShortcut,
  SETTINGS_OPEN_HASH,
} from '@/lib/use-settings-route';

const ShareBranchSwitchDialog = lazy(() =>
  import('@/components/ShareBranchSwitchDialog').then((m) => ({
    default: m.ShareBranchSwitchDialog,
  })),
);

const ShareReceiveMissDialog = lazy(() =>
  import('@/components/ShareReceiveMissDialog').then((m) => ({
    default: m.ShareReceiveMissDialog,
  })),
);

const INSTALL_DIALOG_HASH = '#install-claude-desktop';
const MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN = /\.(md|mdx)$/i;
function isAuxiliaryDialogHash(hash: string): boolean {
  return isSettingsHashOpen(hash) || hash === INSTALL_DIALOG_HASH;
}

function exactOpenMarkdownTabTarget(
  docName: string,
  openTabs: ReadonlyArray<string>,
): ResolvedNavigationTarget | null {
  if (!MARKDOWN_EXTENSION_QUALIFIED_DOC_PATTERN.test(docName)) return null;
  for (const tabId of openTabs) {
    const tab = parseEditorTabId(tabId);
    if (tab.kind === 'doc' && tab.docName === docName) {
      return { kind: 'doc', target: docName, docName };
    }
  }
  return null;
}

function selectedPathForNavigationTarget(target: ResolvedNavigationTarget): string | null {
  switch (target.kind) {
    case 'skill-file':
    case 'skill-preview':
      return target.path ?? null;
    case 'doc':
    case 'folder-index':
    case 'folder':
    case 'asset':
    case 'skills':
    case 'large-file':
    case 'missing':
      return null;
  }
}

function knownTargetsSignature(
  pages: ReadonlySet<string>,
  folderPaths: ReadonlySet<string>,
  assetPaths: ReadonlySet<string>,
  filePaths: ReadonlySet<string>,
): string {
  return [pages, folderPaths, assetPaths, filePaths]
    .map((values) => [...values].sort().join('\u0000'))
    .join('\u0001');
}

function NavigationHandler() {
  const {
    activeNewTabId,
    activeTabId,
    activeTarget,
    clearTarget,
    openTabs,
    syncOpenTabsWithKnownTargets,
    tabSessionLoaded,
  } = useDocumentContext();
  const { openTargetTransition } = useDocumentTransition();
  useReconcileSkillTabs();
  const {
    assetPaths,
    filePaths,
    folderPaths,
    loading,
    pageMeta,
    pages,
    pagesBySlug,
    pagesByBasename,
  } = usePageList();
  const { merged } = useConfigContext();
  const previewTabsEnabled = merged?.editor?.previewTabs ?? true;
  const lastSyncedTargetsSignatureRef = useRef<string | null>(null);
  const historyTraversalUrlRef = useRef<string | null>(null);
  const lastResolvedSurfaceHashRef = useRef<string | null>(null);
  const targetsSignature = knownTargetsSignature(pages, folderPaths, assetPaths, filePaths);

  useEffect(
    () =>
      subscribeLocalMenuAction((action) => {
        if (action === 'navigate-back') window.history.back();
        if (action === 'navigate-forward') window.history.forward();
      }),
    [],
  );

  useEffect(() => {
    if (
      loading ||
      !tabSessionLoaded ||
      lastSyncedTargetsSignatureRef.current === targetsSignature
    ) {
      return;
    }
    lastSyncedTargetsSignatureRef.current = targetsSignature;
    syncOpenTabsWithKnownTargets({ pages, folderPaths, assetPaths, filePaths });
  }, [
    assetPaths,
    filePaths,
    folderPaths,
    loading,
    pages,
    syncOpenTabsWithKnownTargets,
    tabSessionLoaded,
    targetsSignature,
  ]);

  useEffect(() => {
    if (
      consumeHashNavigationSuppression() &&
      window.location.hash !== '' &&
      !isAuxiliaryDialogHash(window.location.hash)
    ) {
      replaceHashWithoutNavigation('');
    }
  }, []);

  useEffect(() => {
    if (!tabSessionLoaded && window.okDesktop?.config.mode === 'editor') return;
    syncTargetFromHash(historyTraversalUrlRef.current);

    function onPopState(event: PopStateEvent) {
      historyTraversalUrlRef.current = isManagedHashHistoryState(event.state)
        ? window.location.href
        : null;
    }

    function onHashChange() {
      const traversedUrl = historyTraversalUrlRef.current;
      historyTraversalUrlRef.current = null;
      syncTargetFromHash(traversedUrl);
    }

    function syncTargetFromHash(traversedUrl: string | null) {
      const isHistoryTraversal = traversedUrl === window.location.href;
      markCurrentHashHistoryEntry();
      const isSurfaceHashRepeat = lastResolvedSurfaceHashRef.current === window.location.hash;
      const latchSurfaceHash = () => {
        lastResolvedSurfaceHashRef.current = window.location.hash;
      };
      const clearSurfaceHash = () => {
        lastResolvedSurfaceHashRef.current = null;
      };
      const openHashTarget = (target: ResolvedNavigationTarget) => {
        clearSurfaceHash();
        if (
          tabIdForNavigationTarget(target) === activeTabId &&
          activeTarget?.kind === target.kind &&
          activeTarget.target === target.target &&
          selectedPathForNavigationTarget(activeTarget) === selectedPathForNavigationTarget(target)
        ) {
          return;
        }
        openTargetTransition(target, {
          disposition: isHistoryTraversal
            ? previewOpenDisposition(previewTabsEnabled)
            : 'permanent',
          consumeActiveNewTab: true,
        });
      };

      if (isAuxiliaryDialogHash(window.location.hash)) {
        return;
      }
      const assetPath = assetPathFromHash(window.location.hash);
      if (assetPath) {
        const assetExt = assetPath.split('.').pop() ?? '';
        const mediaKind = mediaKindForSidebarAssetExtension(assetExt);
        mark('ok/nav/hash-change', { docName: null, kind: 'asset' });
        openHashTarget({
          kind: 'asset',
          target: assetPath,
          assetPath,
          mediaKind,
        });
        return;
      }
      const skillFile = skillFileFromHash(window.location.hash);
      if (skillFile) {
        mark('ok/nav/hash-change', { docName: null, kind: 'skill-file' });
        openHashTarget({
          kind: 'skill-file',
          target: `${skillFile.scope}/${skillFile.name}${skillFile.host ? `:${skillFile.host}` : ''}/${skillFile.path}`,
          scope: skillFile.scope,
          name: skillFile.name,
          path: skillFile.path,
          ...(skillFile.host ? { host: skillFile.host } : {}),
        });
        return;
      }
      if (skillsFromHash(window.location.hash)) {
        if (activeNewTabId !== null) {
          latchSurfaceHash();
          return;
        }
        if (isSurfaceHashRepeat) return;
        mark('ok/nav/hash-change', { docName: null, kind: 'skills' });
        openTargetTransition({ kind: 'skills', target: 'skills' });
        return;
      }
      const skillPreview = skillPreviewFromHash(window.location.hash);
      if (skillPreview) {
        mark('ok/nav/hash-change', { docName: null, kind: 'skill-preview' });
        openHashTarget({
          kind: 'skill-preview',
          target: `${skillPreview.flavor}/${skillPreview.source}/${skillPreview.name}`,
          flavor: skillPreview.flavor,
          source: skillPreview.source,
          name: skillPreview.name,
          subtitle: skillPreview.subtitle,
          level: skillPreview.level,
          path: skillPreview.path,
        });
        return;
      }
      if (isContentRootHash(window.location.hash)) {
        mark('ok/nav/hash-change', { docName: null, kind: 'folder' });
        openHashTarget({ kind: 'folder', target: '', folderPath: '' });
        return;
      }
      const docName = docNameFromHash(window.location.hash);
      if (!docName) {
        if (activeNewTabId !== null) {
          latchSurfaceHash();
          return;
        }
        if (isSurfaceHashRepeat) return;
        mark('ok/nav/hash-change', { docName: null, kind: 'clear' });
        clearTarget();
        return;
      }
      if (loading) {
        mark('ok/nav/hash-change', { docName, kind: 'deferred-loading' });
        return;
      }
      const resolved =
        exactOpenMarkdownTabTarget(docName, openTabs) ??
        resolveNavigationTarget(docName, {
          pages,
          folderPaths,
          pagesBySlug,
          pagesByBasename,
        });
      if (resolved.kind === 'missing' && /\/+$/.test(docName.trim())) {
        mark('ok/nav/hash-change', { docName, kind: 'deferred-missing-folder' });
        return;
      }
      const target = withLargeFileOpenGuard(downgradeFolderIndexForHashNav(resolved), pageMeta);
      mark('ok/nav/hash-change', { docName, kind: target.kind });
      openHashTarget(target);
    }
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [
    activeNewTabId,
    activeTabId,
    activeTarget,
    clearTarget,
    folderPaths,
    loading,
    openTargetTransition,
    openTabs,
    pageMeta,
    pages,
    pagesBySlug,
    pagesByBasename,
    previewTabsEnabled,
    tabSessionLoaded,
  ]);

  return null;
}

function InstallInClaudeDesktopTrigger() {
  const [open, setOpen] = useState(
    typeof window !== 'undefined' && window.location.hash === INSTALL_DIALOG_HASH,
  );

  useEffect(() => {
    function onHashChange() {
      if (window.location.hash === INSTALL_DIALOG_HASH) setOpen(true);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && window.location.hash === INSTALL_DIALOG_HASH) {
      replaceHashWithoutNavigation('');
    }
  }

  return <InstallInClaudeDesktopDialog open={open} onOpenChange={handleOpenChange} />;
}

function SettingsShortcutHandler() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isOverlayLayerOpen()) return;
      const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (
        isSettingsShortcut({
          target,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          key: e.key,
        })
      ) {
        e.preventDefault();
        if (window.location.hash !== SETTINGS_OPEN_HASH) {
          window.location.hash = SETTINGS_OPEN_HASH;
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}

function ActiveTargetBridgePush() {
  const { activeTarget } = useDocumentContext();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;

  const kind =
    activeTarget?.kind === 'doc' ||
    activeTarget?.kind === 'folder' ||
    activeTarget?.kind === 'asset'
      ? activeTarget.kind
      : null;
  const identifier =
    activeTarget?.kind === 'doc'
      ? activeTarget.docName
      : activeTarget?.kind === 'folder'
        ? activeTarget.folderPath
        : activeTarget?.kind === 'asset'
          ? activeTarget.assetPath
          : null;

  useEffect(() => {
    if (!bridge) return;
    if (kind === null) {
      bridge.editor.notifyActiveTargetChanged({ kind: null });
      return;
    }
    if (identifier === null) return;
    bridge.editor.notifyActiveTargetChanged({ kind, identifier });
  }, [bridge, kind, identifier]);

  return null;
}

function NewItemShortcutHandler() {
  const { activeDocName, activeTarget } = useDocumentContext();
  const { pages, addPage } = usePageList();
  const [dialogOpen, setDialogOpen] = useState(false);
  const initialDir =
    activeTarget?.kind === 'folder' ? activeTarget.folderPath : defaultInitialDir(activeDocName);
  const folderConfig = useFolderConfig(initialDir);
  const folderState = folderConfig.state;
  const createInFlightRef = useRef(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isOverlayLayerOpen()) return;
      const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (
        !isNewItemShortcut({
          target,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          key: e.key,
        })
      ) {
        return;
      }
      e.preventDefault();
      if (
        folderState.status !== 'ready' ||
        (folderState.data.folder.templates_available ?? []).length > 0
      ) {
        setDialogOpen(true);
        return;
      }
      if (createInFlightRef.current) return;
      createInFlightRef.current = true;
      const docName = nextUntitledDocName(initialDir, pages);
      void createPageRequest({ path: `${docName}.md`, kind: 'file' })
        .then((result) => {
          if (!result.ok) {
            toast.error(result.error);
            setDialogOpen(true);
            return;
          }
          openCreatedPage(result.docName, addPage);
        })
        .catch((err: unknown) => {
          console.warn('[NewItemShortcutHandler] create tail failed:', err);
          setDialogOpen(true);
        })
        .finally(() => {
          createInFlightRef.current = false;
        });
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [folderState, initialDir, pages, addPage]);

  return (
    <NewItemDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      kind="file"
      initialDir={initialDir}
      folderConfig={folderConfig}
    />
  );
}

function ConfigProviderHost({ children }: { children: ReactNode }) {
  const { collabUrl } = useDocumentContext();
  useServerKeepalive(collabUrl);
  return (
    <ConfigProvider collabUrl={collabUrl}>
      <EditorLifecycleFlush />
      <BackgroundThrottleReporter />
      {children}
    </ConfigProvider>
  );
}

function PreviewTabsSettingsBridge({ children }: { children: ReactNode }) {
  const { merged } = useConfigContext();
  const { promoteAllPreviewTabs } = useDocumentContext();

  useEffect(() => {
    if (merged?.editor?.previewTabs === false) promoteAllPreviewTabs();
  }, [merged?.editor?.previewTabs, promoteAllPreviewTabs]);

  return children;
}

export function App() {
  return (
    <ProfilerBoundary name="app">
      <DocumentProvider>
        <ConfigProviderHost>
          <PreviewTabsSettingsBridge>
            <SingleFileModeProvider>
              <AppBody />
            </SingleFileModeProvider>
          </PreviewTabsSettingsBridge>
        </ConfigProviderHost>
      </DocumentProvider>
    </ProfilerBoundary>
  );
}

function AppBody() {
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const singleFile = useSingleFileMode();
  const noteWindow = isNoteWindow();

  const installedClis = useInstalledClis();
  const terminalLaunch: TerminalLaunchContextValue | null =
    desktopBridge && desktopBridge.config.ptyAvailable === true
      ? {
          launchInTerminal: (input, cli) => {
            requestTerminalLaunch(composeTerminalLaunchPrompt(input, cli), cli);
          },
          installedClis,
        }
      : null;

  return (
    <>
      <ConnectingBanner />
      <BranchRecycleBanner />
      <PageListProvider>
        <NoteWindowMainActionReceiver />
        {}
        {!noteWindow && <SystemDocSubscriber />}
        <ValidationFreshness />
        {}
        <SkillTrackInGitDialog />
        <NavigationHandler />
        <ActiveTargetBridgePush />
        <NewItemShortcutHandler />
        {}
        {!singleFile && !noteWindow && <SettingsShortcutHandler />}
        {SHOW_INSTALL_SKILL && <InstallInClaudeDesktopTrigger />}
        {}
        {desktopBridge ? <CreateProjectMenuTrigger bridge={desktopBridge} /> : null}
        {}
        {desktopBridge ? <ReportBugMenuTrigger /> : null}
        {}
        {desktopBridge ? <FeedbackMenuTrigger /> : null}
        {}
        <McpConsentDialog />
        {}
        {desktopBridge ? (
          <Suspense fallback={null}>
            <ShareBranchSwitchDialog bridge={desktopBridge} />
            <ShareReceiveMissDialog />
          </Suspense>
        ) : null}
        {}
        {!noteWindow && (
          <CommandPalette
            bridge={desktopBridge}
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
          />
        )}
        {}
        {isElectronHost && (
          <div
            aria-hidden="true"
            data-testid="editor-window-chrome-drag-strip"
            data-electron-drag=""
            className="pointer-events-none fixed inset-x-0 top-0 z-50 h-2 [-webkit-app-region:drag]"
          />
        )}
        {}
        <TerminalLaunchProvider value={terminalLaunch}>
          {}
          <CommentQueueShortcut />
          <SidebarProvider className="h-screen overflow-hidden">
            {}
            {!singleFile && !noteWindow && (
              <FileSidebar onOpenSearch={() => setCommandPaletteOpen(true)} />
            )}
            <SidebarInset className="overflow-hidden h-[calc(100vh-var(--layout-inset-offset))]">
              <EditorPane onOpenSearch={() => setCommandPaletteOpen(true)} />
            </SidebarInset>
          </SidebarProvider>
        </TerminalLaunchProvider>
      </PageListProvider>
    </>
  );
}
