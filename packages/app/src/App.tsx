import { mediaKindForSidebarAssetExtension, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
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

// Cold-path receive surface: only mounts when main routes a
// 'project-branch-switch' payload. Lazy so its branch-info / checkout / variant
// code (and the target-status client it pulls in) splits out of the main bundle.
const ShareBranchSwitchDialog = lazy(() =>
  import('@/components/ShareBranchSwitchDialog').then((m) => ({
    default: m.ShareBranchSwitchDialog,
  })),
);

// Cold-path receive surface: the honest verdict modal for a share deep link
// whose target is absent on the receiver's branch. Self-gates on
// `missDialogStore`; lazy so its verdict-fetch code splits out of the main
// bundle until a miss actually occurs.
const ShareReceiveMissDialog = lazy(() =>
  import('@/components/ShareReceiveMissDialog').then((m) => ({
    default: m.ShareReceiveMissDialog,
  })),
);

/**
 * Hashes that open overlay dialogs (Settings, Install Claude Desktop)
 * rather than navigate to a document. NavigationHandler treats these as
 * no-ops so the dialog can mount over the existing editor without
 * `clearTarget()` blowing away the underlying document — the dialog
 * portals atop whatever's already there. Hoisted here (above
 * NavigationHandler) so the predicate can reference both constants;
 * `INSTALL_DIALOG_HASH`'s definition stays where it's used by the
 * trigger component to keep that locality.
 */
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
  // Reconcile open skill tabs against the live skills list: an agent/MCP/server-
  // side scope move only broadcasts `files` (never retargets the client tab),
  // leaving an open skill tab pointing at a doc that no longer exists.
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
      // Overlay-dialog hashes (settings, install) don't replace the
      // active document — they portal a Dialog over it. Skipping
      // here keeps the editor mounted underneath; without this guard
      // the no-doc-name branch below would call `clearTarget()` and
      // the editor would flash to <EmptyEditorState> behind the
      // dialog on every Cmd-,.
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
      // Content-root sentinel `#/` (the form a root-folder share deep link
      // navigates to, and `hashFromFolderPath('')` emits) → the content-root
      // folder overview. Distinct from an EMPTY hash (`''`), which falls
      // through to the no-doc-name `clearTarget()` branch below. Both
      // `docNameFromHash('#/')` and `docNameFromHash('')` return null, so the
      // sentinel check must run BEFORE the null-docName clear.
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

/**
 * One-shot base-open deep-link: when the UI opens at its base (no doc / asset /
 * dialog in the hash — e.g. the Claude pane's `preview_start`), apply an armed
 * pane target from `/api/config` so the pane lands on the agent's intended
 * doc/folder instead of an empty splash. Fires once at mount; navigates only if
 * the page is still at base when the fetch resolves (so it never overrides a
 * deep link the user opened directly or navigated to meanwhile). When no target
 * is armed (or it expired), it does nothing and the normal root view shows.
 */
function PaneTargetLanding() {
  // No `didRun` ref: a ref set synchronously persists across React Strict
  // Mode's dev double-invoke, which would make the first run's cleanup cancel
  // the fetch and the second run early-return — so the effect would silently do
  // nothing in dev. The `cancelled` flag + the `atBase` re-check already make
  // re-running safe and idempotent (it only navigates from a base hash).
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
        // Only apply a well-formed in-app route fragment, and only if we're still
        // at base (the user hasn't navigated during the fetch).
        if (!target?.startsWith('#/')) return;
        if (!atBase(window.location.hash)) return;
        window.location.hash = target;
        // Consume the one-shot target so a reload within its TTL doesn't yank
        // back here. Fire-and-forget — re-navigation is the only cost if it
        // fails, and the server-side TTL caps that anyway.
        void fetch('/api/config', { method: 'DELETE' }).catch(() => {});
      })
      // fetchApiConfig rethrows AbortError on unmount — expected, swallow it.
      .catch(() => {});
    // Aborting on unmount cancels the inflight request, not just its handler —
    // symmetric with the rest of the app's /api/config consumers.
    return () => controller.abort();
  }, []);
  return null;
}

/**
 * Mounts `InstallInClaudeDesktopDialog` at the App root and opens it when
 * `window.location.hash === '#install-claude-desktop'`. Docs and in-app CTAs
 * link to the hash to deep-link into the dialog. The hash clears when the
 * dialog closes so it reopens only if the user navigates back to the URL
 * fragment.
 *
 * `INSTALL_DIALOG_HASH` is declared above (alongside `isAuxiliaryDialogHash`)
 * so NavigationHandler can short-circuit on it.
 */
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
      // Clear the fragment so closing doesn't instantly re-open on refresh.
      // Uses history.replaceState to avoid adding a history entry.
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', `${pathname}${search}`);
    }
  }

  return <InstallInClaudeDesktopDialog open={open} onOpenChange={handleOpenChange} />;
}

/**
 * Cmd-, / Ctrl-, opens the Settings dialog. Sibling to
 * `NewItemShortcutHandler` — global keydown listener at App scope, suppresses
 * inside text inputs (`isSettingsShortcut`), routes to the canonical hash so
 * `useSettingsRoute` (mounted by EditorArea) reacts and renders SettingsDialog.
 *
 * Browser-mode-only in practice: Electron's menu accelerator (`CmdOrCtrl+,`
 * on the App / File menu Settings… item) captures the keypress before it
 * reaches the renderer, so this handler firing inside Electron is a no-op
 * because the menu's executeJavaScript already set the same hash. Both code
 * paths produce identical end state.
 */
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

/**
 * Pushes the editor area's active target to main via
 * `bridge.editor.notifyActiveTargetChanged`. Drives the macOS File menu's
 * state-aware enable/disable for items like Rename / Move to Trash / Send
 * to AI. Web-host short-circuits when the desktop bridge is absent.
 *
 * Lives at the App-tier where `useDocumentContext()` is already mounted —
 * exactly one push site keeps the last-write-wins semantics main relies on
 * (`editorActiveTarget` is module-scope, singleton across windows). Effect
 * deps are narrowed to the discriminator + identifier so a render that
 * re-creates an equal `activeTarget` reference doesn't re-fire the push —
 * the snapshot main consumes is normalized to the same four shapes.
 *
 * Snapshot shape mirrors `EditorActiveTargetSnapshot`'s discriminated union
 * (doc / folder / asset / null). `folder-index` and `missing` collapse to
 * `kind: null` because main doesn't need state-aware enable for those
 * scopes today — File menu items either always-enable (Reveal in Finder
 * for contentDir, New File) or always-disable (Rename / Move to Trash
 * with no concrete target).
 */
function ActiveTargetBridgePush() {
  const { activeTarget } = useDocumentContext();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;

  // Narrow the unbounded ResolvedNavigationTarget union to the shapes the
  // menu surface understands. doc / folder / asset are enable-bearing
  // scopes; everything else (folder-index, missing, null) renders as the
  // project-scope state.
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
      // KeyboardEvent.target is EventTarget|null — widen to the duck-typed
      // ShortcutEventLike shape used by the pure predicate.
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

/**
 * App-tier host that reads `collabUrl` from DocumentContext and passes it to
 * `ConfigProvider` as a prop, keeping `ConfigProvider` (in `lib/`) free of any
 * `editor/` import. That layering inversion is what closed the DocumentContext
 * value-import cycle behind the CI "export not found" flake — don't collapse it
 * back into `<ConfigProvider>` reading `useDocumentContext()` directly.
 */
function ConfigProviderHost({ children }: { children: ReactNode }) {
  const { collabUrl } = useDocumentContext();
  // App-lifetime keepalive so an open tab keeps its `ok start` server alive
  // even with no document open. Independent of the per-doc provider pool;
  // self-gates to non-desktop. Mounted here because this host already owns the
  // single app-root `collabUrl` read.
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

/**
 * App chrome body. Split out from `App` so it sits BELOW `SingleFileModeProvider`
 * and can read `useSingleFileMode()` — the no-project ephemeral session
 * (`ok <file>`) drops project chrome (file sidebar / tabs / project switcher /
 * Settings) here while the editor itself (`EditorPane` → `EditorArea`) stays
 * fully editable.
 */
function AppBody() {
  // Workspace omnibar: shared across web and Electron for file/folder
  // navigation and command dispatch. Electron additionally surfaces
  // project-level commands when the desktop bridge exists.
  // Mounted at the App root so Cmd/Ctrl+K works regardless of focus.
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const singleFile = useSingleFileMode();

  // "Open in terminal" launcher — desktop-only. Routes a scope-derived prompt
  // to the docked terminal in EditorPane. `composeTerminalLaunchPrompt` drops
  // the "Open the OK editor in web view." trailer the web deep-link handoff
  // carries: the terminal launches next to an already-open editor, so that
  // directive would point the agent at a surface the user is already viewing.
  // Null on the web host (no real OS shell) so the menu rows that consume it
  // render nothing.
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
        {desktopBridge ? (
          <Suspense fallback={null}>
            <ShareBranchSwitchDialog bridge={desktopBridge} />
            <ShareReceiveMissDialog />
          </Suspense>
        ) : null}
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
