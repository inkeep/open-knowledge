import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import { TagDialog } from '@/editor/components/TagDialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { RAW_MDX_NAV_EVENT, type RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { type EditorModeValue, useEditorMode } from '@/editor/use-editor-mode';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { useNoPushPermissionToast } from '@/hooks/use-no-push-permission-toast';
import { useWorktreeAutoSyncNotice } from '@/hooks/use-worktree-autosync-notice';
import { useConfigContext } from '@/lib/config-provider';
import { resolveDefaultCli } from '@/lib/default-cli-resolver';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import {
  getInitialTerminalDock,
  type TerminalDockPosition,
  writeTerminalDock,
} from '@/lib/terminal-dock-store';
import { readPreferBareTerminal } from '@/lib/terminal-new-tab-store';
import { recordTerminalOpened } from '@/lib/terminal-telemetry';
import { loadStickyAgent } from '@/lib/unified-agent-store';
import { AuthModal } from './AuthModal';
import { AutoSyncOnboardingDialog } from './AutoSyncOnboardingDialog';
import { shouldShowAutoSyncOnboarding } from './auto-sync-onboarding-gate';
import { type PanelTab, TABS } from './DocPanel';
import { EditorArea, type TerminalPlacement } from './EditorArea';
import { EditorHeader } from './EditorHeader';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';
import { TerminalSessionsHost } from './TerminalSessionsHost';

/**
 * Carries an "Open in terminal" launch from a UI click to the docked terminal
 * session. `prompt` is the same scope-specific string the deep-link puts in
 * `q=`, OR `null` for a "New chat" launch — a promptless bare-CLI session with
 * no composed scope. `cli` is the chosen agent CLI (`claude` / `codex` /
 * `cursor` / `opencode`); `nonce` makes each click a distinct, idempotent intent
 * so the session writes the launch exactly once per click.
 */
export interface TerminalLaunchIntent {
  readonly prompt: string | null;
  readonly cli: TerminalCli;
  readonly nonce: number;
}

export type EditorMode = EditorModeValue;

interface EditorPaneProps {
  onOpenSearch?: () => void;
}

export function EditorPane({ onOpenSearch }: EditorPaneProps = {}) {
  // Persisted preference (localStorage). Read once at mount via
  // `useEditorMode`'s `useState` initializer and seeded into session-local
  // `editorMode`. Open tabs are independent for their lifetime;
  // the persisted value applies at load (refresh / new tab / new window).
  const [persistedMode, setPersistedMode] = useEditorMode();
  const [editorMode, setEditorMode] = useState<EditorMode>(persistedMode);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialStep, setAuthInitialStep] = useState<'auth' | 'identity'>('auth');
  const [activeTab, setActiveTab] = useState<PanelTab>(TABS[0].id);
  const [autoSyncOnboardingDismissed, setAutoSyncOnboardingDismissed] = useState(false);
  // Bottom-docked terminal — desktop-only (the bridge is absent in the web
  // host, where a real shell is out of scope). Visibility starts hidden; the
  // Cmd/Ctrl+J + View-menu toggle drives this state (wired below).
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  // The terminal feature (dock + header New chat / toggle) needs not just a
  // desktop bridge but one that actually exposes the `terminal` surface — a
  // session-only bridge (some E2E hosts) has none. Gate every terminal
  // affordance on this so a control that can't launch never renders.
  const terminalAvailable = desktopBridge != null && desktopBridge.terminal != null;
  const [terminalVisible, setTerminalVisible] = useState(false);
  // Which launchable CLIs are on PATH (desktop probe, cached ~60s in main).
  // Feeds the New-chat default-CLI auto-pick. Starts empty, so resolveDefaultCli
  // degrades to claude until the probe resolves. Shared with the Ask-X bubble.
  const installedClis = useInstalledClis();
  // Whether the terminal currently holds any session (reported up by the host).
  // The header's New chat button reads this to decide between bootstrapping a
  // first chat and merely revealing an already-populated dock.
  const [hasSessions, setHasSessions] = useState(false);
  // Gates the View-menu visibility push (below) until the mount-time dock-state
  // restore has read main's retained per-window visibility. Without the gate the
  // reconnecting renderer's initial `false` push overwrites that retained value
  // before the restore reads it back, so a reloaded window never re-expands its
  // dock. Settles `true` after the restore resolves (or fails); a fresh launch
  // settles to a `false` push and the dock stays hidden. Mirrors TerminalDock's
  // `rehydrationSettled` latch.
  const [dockRestoreSettled, setDockRestoreSettled] = useState(false);
  // One-shot marker set when the restore itself drives the false→true reveal, so
  // the adoption telemetry below doesn't count an automatic reload-restore as a
  // user-initiated open.
  const restoreRevealRef = useRef(false);
  // Launch intent threaded to the terminal session for the "Open in terminal"
  // entry point. Null until a UI click; bumping `nonce` makes each click a
  // distinct one-shot the session writes exactly once.
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunchIntent | null>(null);
  // Where the terminal docks (right default | bottom), persisted per machine.
  // Moving the terminal is also a request to see it, so the setter reveals the
  // dock — re-docking a hidden terminal that stays hidden would feel inert.
  const [terminalDock, setTerminalDockState] =
    useState<TerminalDockPosition>(getInitialTerminalDock);
  function setTerminalDock(next: TerminalDockPosition) {
    setTerminalDockState(next);
    writeTerminalDock(next);
    setTerminalVisible(true);
  }
  // The tab strip's dock-toggle button flips between the bottom dock and the right
  // column. Reading `terminalDock` from the render closure is correct for the click
  // path: React commits each click in its own render, so the closure is always the
  // freshly-committed position — a double-click flips back and forth as expected.
  function toggleTerminalDock() {
    setTerminalDock(terminalDock === 'right' ? 'bottom' : 'right');
  }
  // The live terminal session host is mounted HERE (below), above EditorArea, so a
  // dock toggle — which remounts EditorArea's subtree — can't re-spawn the terminal
  // (the VS Code / Zed pattern: own the terminal above the movable layout, re-attach
  // the view). EditorArea reports where to attach via onTerminalPlacement.
  const [terminalPlacement, setTerminalPlacement] = useState<TerminalPlacement>({
    container: null,
    isShowing: false,
    dockPosition: 'bottom',
    editorRegion: null,
  });
  // Monotonic source for the launch nonce. It must survive the hide-clear of
  // `terminalLaunch` below — deriving the next nonce from the prior intent would
  // restart at 1 after a hide, letting two distinct clicks collide on a nonce
  // the dock would then dedup away as a repeat.
  const launchNonceRef = useRef(0);

  // Header + tab-strip "New chat": launch a CLI with NO prompt (a blank session).
  // Resolve the CLI from the sticky pick + installed set unless the caller names
  // one, reveal the dock, and thread a promptless one-shot intent through the
  // same nonce-dedup + hide-clear path as "Open in terminal". Distinct from the
  // prompt-composing `subscribeToTerminalLaunchRequests` path below — New chat
  // needs no doc scope.
  function launchNewChat(cli?: TerminalCli) {
    const resolvedCli = cli ?? resolveDefaultCli(loadStickyAgent(), installedClis);
    setTerminalVisible(true);
    launchNonceRef.current += 1;
    setTerminalLaunch({ prompt: null, cli: resolvedCli, nonce: launchNonceRef.current });
  }

  // Reveal the docked terminal and, if no session exists yet, seed a first one.
  // Drives the edge "Show terminal" reveal tab; leaves the right doc-panel
  // untouched (the two coexist). The seed honors the sticky new-tab pick: for a
  // CLI, launch a chat under the default CLI; when the last pick was a bare
  // "Terminal" (persisted terminal-only), skip the CLI launch and let the host's
  // reveal-from-empty fallback seed a bare shell instead.
  function revealTerminal() {
    setTerminalVisible(true);
    if (!hasSessions && !readPreferBareTerminal()) launchNewChat();
  }

  const syncStatus = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();

  const { activeDocName } = useDocumentContext();

  // Onboarding modal: open once per machine per project when every gate
  // input aligns. Decision logic lives in `shouldShowAutoSyncOnboarding`
  // so each input has its own row in the helper's truth table.
  const showAutoSyncOnboarding = shouldShowAutoSyncOnboarding({
    autoSyncOnboardingDismissed,
    hasRemote: syncStatus?.hasRemote,
    projectLocalSynced,
    projectSynced,
    projectLocalConfig,
    projectConfig,
    pushPermissionCheckStatus: syncStatus?.pushPermission?.checkStatus,
  });

  // rawMdxFallback click → switch to source mode so user can fix the broken MDX.
  // The pending navigation store preserves the target offset until the source
  // chunk finishes loading for the active doc.
  useEffect(() => {
    function onRawMdxNav(e: Event) {
      const detail = (e as CustomEvent<RawMdxNavDetail>).detail;
      if (detail && activeDocName) {
        rememberPendingSourceNavigation(activeDocName, { kind: 'raw-mdx', detail });
      }
      setEditorMode('source');
    }
    window.addEventListener(RAW_MDX_NAV_EVENT, onRawMdxNav);
    return () => window.removeEventListener(RAW_MDX_NAV_EVENT, onRawMdxNav);
  }, [activeDocName]);

  // Bottom-terminal toggle, dual-wired like the DocPanel: on desktop the
  // View → Terminal item's ⌘J/Ctrl+J accelerator is OS-captured and dispatches
  // `toggle-terminal`; the web host has no menu, so a window keydown stands in.
  useEffect(() => {
    const bridge = window.okDesktop;
    if (bridge == null) return;
    return bridge.onMenuAction((action) => {
      if (action === 'toggle-terminal') {
        setTerminalVisible((visible) => !visible);
      } else if (action === 'new-terminal') {
        // Terminal menu "New Terminal": reveal the dock (it never hides, unlike
        // the toggle). The dock adds the new tab itself off the same action; this
        // only owns visibility and covers the case where no dock is mounted yet.
        setTerminalVisible(true);
      }
    });
  }, []);

  useEffect(() => {
    if (window.okDesktop != null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (matchesKeyboardShortcut(event, 'toggle-terminal-panel')) {
        event.preventDefault();
        setTerminalVisible((visible) => !visible);
      }
    }
    // Capture phase so a focused xterm textarea can't swallow ⌘J first.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // "Open in terminal" launch — a handoff-menu click fires a window event with
  // the composed prompt. Open the dock (the terminal is allowed by default; the
  // gate only blocks a project explicitly opted out) AND carry the prompt to the
  // session as a fresh one-shot intent. The nonce comes from the monotonic ref,
  // so every click is a strictly increasing, never-reused intent: each one opens
  // its own tab and the dock can dedup re-renders by nonce without dropping a
  // genuinely new launch. Desktop-only; the web host never renders the entry point.
  useEffect(() => {
    return subscribeToTerminalLaunchRequests((prompt, cli) => {
      setTerminalVisible(true);
      launchNonceRef.current += 1;
      setTerminalLaunch({ prompt, cli, nonce: launchNonceRef.current });
    });
  }, []);

  // Clear the one-shot launch intent whenever the terminal hides. The
  // exactly-once-per-nonce guard lives inside the session, which is destroyed
  // when a kill drops the dock's mount latch — so without clearing here, the
  // next fresh mount (New Terminal / reopen after a kill) would re-apply the
  // stale intent and relaunch the previous "Open in terminal" prompt instead
  // of starting blank. Collapse keeps the session mounted, so clearing the
  // already-consumed intent is a no-op there.
  useEffect(() => {
    if (!terminalVisible) setTerminalLaunch(null);
  }, [terminalVisible]);

  // Reflect terminal visibility to main so the View menu label flips between
  // "Show Terminal" and "Hide Terminal". Gated on the dock-state restore so the
  // mount-initial `false` can't overwrite main's retained per-window visibility
  // before the restore reads it (the reload re-expand depends on that value).
  // The first push after the restore settles carries the restored — or
  // fresh-launch hidden — visibility. Desktop-only.
  useEffect(() => {
    if (window.okDesktop == null) return;
    if (!dockRestoreSettled) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({ terminalVisible });
  }, [terminalVisible, dockRestoreSettled]);

  // Restore the dock's expanded state after a renderer reload: main retains the
  // per-window visibility (written by the gated push above once this settles),
  // so a reloaded window re-expands the dock when it was open before the reload.
  // Reads false after a fresh launch (main has no retained state), so the dock
  // stays hidden. Run-once; only ever expands (never force-hides), so a user
  // toggle that races the restore is never overridden closed. Settling the gate
  // (always, even on a read failure) releases the deferred push so the View menu
  // converges. Desktop-only.
  useEffect(() => {
    const bridge = window.okDesktop;
    if (bridge == null) return;
    // Capability-guard like TerminalDock's list(): a desktop bridge without a
    // terminal surface (or without getDockState) must still settle the gate so
    // the deferred view-menu push converges, rather than throwing synchronously.
    // Optional-chain `terminal` too: a session-only desktop bridge (e.g. the
    // editor-tab restore E2E) has no `terminal` at all, so `bridge.terminal.x`
    // would throw on mount and crash the whole editor pane.
    if (typeof bridge.terminal?.getDockState !== 'function') {
      setDockRestoreSettled(true);
      return;
    }
    let cancelled = false;
    void bridge.terminal
      .getDockState()
      .then((state) => {
        if (cancelled || !state.visible) return;
        // The restore — not the user — is driving this reveal; mark it so the
        // adoption telemetry below skips it.
        restoreRevealRef.current = true;
        setTerminalVisible(true);
      })
      .catch((err) => {
        // Leave a breadcrumb instead of swallowing: a restore failure is
        // otherwise indistinguishable from "main had no retained state", and the
        // dock silently stays hidden. Mirrors the list() catch in TerminalDock.
        console.error('[terminal] dock-state restore failed; staying hidden:', err);
      })
      .finally(() => {
        if (!cancelled) setDockRestoreSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Adoption telemetry: count each open (the false→true transition). Starts
  // hidden, so the mount run is a no-op; desktop-only (the dock is too). The
  // reload-restore reveal is not a user open — consume its one-shot marker so it
  // isn't counted; a genuine ⌘J / menu open leaves the marker unset.
  useEffect(() => {
    if (window.okDesktop == null) return;
    if (restoreRevealRef.current) {
      restoreRevealRef.current = false;
      return;
    }
    if (terminalVisible) recordTerminalOpened();
  }, [terminalVisible]);

  // One-time toast when the engine pauses sync for missing push permission.
  // The engine only sets that reason when `autoSync.enabled === true` AND
  // the probe resolves `denied`, so this fires exactly for the migration
  // shape the in-memory pause was designed for. Extracted to a hook so
  // the fire-once-on-leading-edge behavior is testable in isolation.
  useNoPushPermissionToast(syncStatus?.pausedReason);

  // One-time notice when this window is a worktree that inherited the root
  // project's auto-sync setting (fires + self-clears its seeded flag).
  useWorktreeAutoSyncNotice();

  function handleModeChange(mode: EditorModeValue) {
    setEditorMode(mode);
    // User-initiated change — persist globally. Tool-driven flips (e.g.
    // RAW_MDX_NAV_EVENT → source) are session-only and deliberately do NOT
    // call setPersistedMode.
    setPersistedMode(mode);
  }

  return (
    <>
      <EditorHeader
        onSignIn={() => {
          setAuthInitialStep('auth');
          setAuthModalOpen(true);
        }}
        onSetIdentity={() => {
          setAuthInitialStep('identity');
          setAuthModalOpen(true);
        }}
        onOpenSearch={onOpenSearch}
      />
      {/* The terminal docks to the right of the doc panel (its own column) or
          under the editor/file column. EditorArea owns the layout; the dock
          position, visibility, and the dock-toggle/collapse controls' state stay
          owned here and are threaded down — to EditorArea (placement) and to the
          session host (which renders the tab strip's controls via its portal). */}
      <EditorArea
        editorMode={editorMode}
        onModeChange={handleModeChange}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
        terminalBridge={desktopBridge}
        terminalVisible={terminalVisible}
        onTerminalVisibleChange={setTerminalVisible}
        terminalDock={terminalDock}
        onTerminalPlacement={setTerminalPlacement}
        onRevealTerminal={terminalAvailable ? revealTerminal : undefined}
      />
      {/* The `desktopBridge != null` clause re-narrows the bridge to non-null for
          the prop — the derived `terminalAvailable` boolean can't narrow it. */}
      {terminalAvailable && desktopBridge != null ? (
        <TerminalSessionsHost
          bridge={desktopBridge}
          visible={terminalVisible}
          onVisibleChange={setTerminalVisible}
          launch={terminalLaunch}
          installedClis={installedClis}
          container={terminalPlacement.container}
          isShowing={terminalPlacement.isShowing}
          onRequestEditorFocus={() => terminalPlacement.editorRegion?.focus()}
          dockPosition={terminalDock}
          onToggleDock={toggleTerminalDock}
          onHasSessionsChange={setHasSessions}
        />
      ) : null}
      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        identityPrompt={authInitialStep === 'identity'}
        onSuccess={() => {
          setAuthModalOpen(false);
        }}
      />
      <AutoSyncOnboardingDialog
        open={showAutoSyncOnboarding}
        onResolved={() => setAutoSyncOnboardingDismissed(true)}
      />
      <TagDialog />
      {/*
        Agent Activity Panel now lives inside DocPanel as the `'agent'` mode
        content.
        No longer mounted here — the mode toggle + DocumentContext
        (`docPanelMode` / `docPanelAgentId`) drive visibility. Presence-bar
        avatar clicks flip the DocPanel's mode + scope + trigger expand.
      */}
    </>
  );
}
