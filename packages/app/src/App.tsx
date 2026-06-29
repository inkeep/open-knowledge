import { mediaKindForSidebarAssetExtension, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CommandPalette } from '@/components/CommandPalette';
import { ConnectingBanner } from '@/components/ConnectingBanner';
import { CreateProjectMenuTrigger } from '@/components/CreateProjectMenuTrigger';
import { EditorPane } from '@/components/EditorPane';
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
import {
  downgradeFolderIndexForHashNav,
  resolveNavigationTarget,
  withLargeFileOpenGuard,
} from '@/components/navigation-targets';
import { PageListProvider, usePageList } from '@/components/PageListContext';
import { ShareBranchSwitchDialog } from '@/components/ShareBranchSwitchDialog';
import { SystemDocSubscriber } from '@/components/SystemDocSubscriber';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import {
  DocumentProvider,
  useDocumentContext,
  useDocumentTransition,
} from '@/editor/DocumentContext';
import { useReconcileSkillTabs } from '@/hooks/use-reconcile-skill-tabs';
import { fetchApiConfig } from '@/lib/api-config';
import { ConfigProvider } from '@/lib/config-provider';
import {
  assetPathFromHash,
  docNameFromHash,
  isContentRootHash,
  skillFileFromHash,
} from '@/lib/doc-hash';
import { mark, ProfilerBoundary } from '@/lib/perf';
import { SingleFileModeProvider, useSingleFileMode } from '@/lib/single-file-mode';
import { useServerKeepalive } from '@/lib/use-server-keepalive';
import { isSettingsShortcut, SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';

const INSTALL_DIALOG_HASH = '#install-claude-desktop';
function isAuxiliaryDialogHash(hash: string): boolean {
  return hash === SETTINGS_OPEN_HASH || hash === INSTALL_DIALOG_HASH;
}

function knownTargetsSignature(
  pages: ReadonlySet<string>,
  folderPaths: ReadonlySet<string>,
  assetPaths: ReadonlySet<string>,
): string {
  return [pages, folderPaths, assetPaths]
    .map((values) => [...values].sort().join('\u0000'))
    .join('\u0001');
}

/** Hash is the source of truth for navigation; all navigation sets the hash;
 *  this handler is the single place that resolves the active navigation target
 *  and calls openTargetTransition(). The transition wrapper keeps the
 *  already-revealed doc visible while the next entry suspends on syncPromise
 *  (fast/warm path); on cold paths `openTargetTransition` drops the transition
 *  and lets `<Suspense fallback={<EditorSkeleton />}>` paint immediately.
 *  Agent-driven nav via SystemDocSubscriber flows through
 *  `window.location.hash`, so it inherits the same UX without a separate code
 *  path. Target resolution (asset / doc / folder-index / folder / missing)
 *  lives here plus resolveNavigationTarget. */
function NavigationHandler() {
  const { clearTarget, syncOpenTabsWithKnownTargets, tabSessionLoaded } = useDocumentContext();
  const { openTargetTransition } = useDocumentTransition();
  useReconcileSkillTabs();
  const { assetPaths, folderPaths, loading, pageMeta, pages, pagesBySlug, pagesByBasename } =
    usePageList();
  const lastSyncedTargetsSignatureRef = useRef<string | null>(null);
  const targetsSignature = knownTargetsSignature(pages, folderPaths, assetPaths);

  useEffect(() => {
    if (
      loading ||
      !tabSessionLoaded ||
      lastSyncedTargetsSignatureRef.current === targetsSignature
    ) {
      return;
    }
    lastSyncedTargetsSignatureRef.current = targetsSignature;
    syncOpenTabsWithKnownTargets({ pages, folderPaths, assetPaths });
  }, [
    assetPaths,
    folderPaths,
    loading,
    pages,
    syncOpenTabsWithKnownTargets,
    tabSessionLoaded,
    targetsSignature,
  ]);

  useEffect(() => {
    onHashChange();

    function onHashChange() {
      if (isAuxiliaryDialogHash(window.location.hash)) {
        return;
      }
      const assetPath = assetPathFromHash(window.location.hash);
      if (assetPath) {
        const assetExt = assetPath.split('.').pop() ?? '';
        const mediaKind = mediaKindForSidebarAssetExtension(assetExt);
        mark('ok/nav/hash-change', { docName: null, kind: 'asset' });
        openTargetTransition({
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
        openTargetTransition({
          kind: 'skill-file',
          target: `${skillFile.scope}/${skillFile.name}/${skillFile.path}`,
          scope: skillFile.scope,
          name: skillFile.name,
          path: skillFile.path,
        });
        return;
      }
      if (isContentRootHash(window.location.hash)) {
        mark('ok/nav/hash-change', { docName: null, kind: 'folder' });
        openTargetTransition({ kind: 'folder', target: '', folderPath: '' });
        return;
      }
      const docName = docNameFromHash(window.location.hash);
      if (!docName) {
        mark('ok/nav/hash-change', { docName: null, kind: 'clear' });
        clearTarget();
        return;
      }
      if (loading) {
        mark('ok/nav/hash-change', { docName, kind: 'deferred-loading' });
        return;
      }
      const resolved = resolveNavigationTarget(docName, {
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
      openTargetTransition(target);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [
    clearTarget,
    folderPaths,
    loading,
    openTargetTransition,
    pageMeta,
    pages,
    pagesBySlug,
    pagesByBasename,
  ]);

  return null;
}

function PaneTargetLanding() {
  useEffect(() => {
    const atBase = (hash: string) =>
      !isAuxiliaryDialogHash(hash) &&
      !assetPathFromHash(hash) &&
      !docNameFromHash(hash) &&
      (hash === '' || hash === '#' || hash === '#/');
    if (!atBase(window.location.hash)) return;
    const controller = new AbortController();
    void fetchApiConfig(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.status !== 'ok') return;
        const target = result.config.paneTarget;
        if (!target?.startsWith('#/')) return;
        if (!atBase(window.location.hash)) return;
        window.location.hash = target;
        void fetch('/api/config', { method: 'DELETE' }).catch(() => {});
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
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
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', `${pathname}${search}`);
    }
  }

  return <InstallInClaudeDesktopDialog open={open} onOpenChange={handleOpenChange} />;
}

function SettingsShortcutHandler() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const initialDir =
    activeTarget?.kind === 'folder' ? activeTarget.folderPath : defaultInitialDir(activeDocName);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (
        isNewItemShortcut({
          target,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          key: e.key,
        })
      ) {
        e.preventDefault();
        setDialogOpen(true);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <NewItemDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      kind="file"
      initialDir={initialDir}
    />
  );
}

function ConfigProviderHost({ children }: { children: ReactNode }) {
  const { collabUrl } = useDocumentContext();
  useServerKeepalive(collabUrl);
  return <ConfigProvider collabUrl={collabUrl}>{children}</ConfigProvider>;
}

export function App() {
  return (
    <ProfilerBoundary name="app">
      <DocumentProvider>
        <ConfigProviderHost>
          <SingleFileModeProvider>
            <AppBody />
          </SingleFileModeProvider>
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

  const terminalLaunch: TerminalLaunchContextValue | null = desktopBridge
    ? {
        launchInTerminal: (input, cli) => {
          requestTerminalLaunch(composeTerminalLaunchPrompt(input, cli), cli);
        },
      }
    : null;

  return (
    <>
      <ConnectingBanner />
      <PageListProvider>
        <SystemDocSubscriber />
        <NavigationHandler />
        <PaneTargetLanding />
        <ActiveTargetBridgePush />
        <NewItemShortcutHandler />
        {/* Settings is unavailable in single-file mode (config editing is
            inert), so the Cmd-, route handler isn't mounted. */}
        {!singleFile && <SettingsShortcutHandler />}
        {SHOW_INSTALL_SKILL && <InstallInClaudeDesktopTrigger />}
        {/* File → New project… opens CreateProjectDialog here.
            Desktop-only — the `new-project` menu action never fires in
            the web host, so the dialog stays unmounted there. */}
        {desktopBridge ? <CreateProjectMenuTrigger bridge={desktopBridge} /> : null}
        {/* First-launch consent dialog — host-agnostic. Self-gates on
            the shared `mcpConsentStore` snapshot; renders nothing until
            main fires `ok:mcp-wiring:show`. Mounted identically in
            NavigatorApp. */}
        <McpConsentDialog />
        {/* Project-scoped branch-switch surface. Self-gates on the
            shared shareReceiveStore — mounts only when main routes a
            'project-branch-switch' payload to this editor window.
            Clone / locate / consent surfaces live on the Navigator,
            never in an editor (see NavigatorApp). */}
        {desktopBridge ? <ShareBranchSwitchDialog bridge={desktopBridge} /> : null}
        <CommandPalette
          bridge={desktopBridge}
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
        />
        {/* Electron BrowserWindow renders with `titleBarStyle: 'hiddenInset'` +
            `transparent: true` + `vibrancy: 'sidebar'`, so the renderer owns
            window-drag affordance. Existing chrome rows (EditorHeader,
            SidebarHeader, EditorTabs) cover y=8..y=56; this 8px strip covers
            the y=0..y=8 vibrancy band above them. */}
        {isElectronHost && (
          <div
            aria-hidden="true"
            data-testid="editor-window-chrome-drag-strip"
            data-electron-drag=""
            className="pointer-events-none fixed inset-x-0 top-0 z-50 h-2 [-webkit-app-region:drag]"
          />
        )}
        {/* The "Open in terminal" entry point spans both the FileSidebar
            menus and the EditorHeader/EditorPane, which are siblings here —
            so the provider wraps both. Its value is desktop-gated; the docked
            terminal that consumes the launch lives in EditorPane. */}
        <TerminalLaunchProvider value={terminalLaunch}>
          <SidebarProvider className="h-screen overflow-hidden">
            {/* No-project single-file mode drops the file sidebar (file tree +
                project switcher); the editor inset takes the full width. */}
            {!singleFile && <FileSidebar onOpenSearch={() => setCommandPaletteOpen(true)} />}
            <SidebarInset className="overflow-hidden h-[calc(100vh-var(--layout-inset-offset))]">
              <EditorPane onOpenSearch={() => setCommandPaletteOpen(true)} />
            </SidebarInset>
          </SidebarProvider>
        </TerminalLaunchProvider>
      </PageListProvider>
    </>
  );
}
