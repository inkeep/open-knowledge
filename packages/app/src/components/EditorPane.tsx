import type { TerminalCli } from '@inkeep/open-knowledge-core';
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getEditorForDoc } from '@/editor/active-editor';
import { EmojiInsertPopover } from '@/editor/components/EmojiInsertPopover';
import { TagDialog } from '@/editor/components/TagDialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { RAW_MDX_NAV_EVENT, type RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { captureModeSwitchAnchor, requestViewInSource } from '@/editor/mode-switch-landing';
import { getSelectionContext } from '@/editor/selection-context';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { type EditorModeValue, useEditorMode } from '@/editor/use-editor-mode';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '@/editor/view-in-source-event';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { useNoPushPermissionToast } from '@/hooks/use-no-push-permission-toast';
import { useWorktreeAutoSyncNotice } from '@/hooks/use-worktree-autosync-notice';
import { authPromptStore } from '@/lib/auth-prompt-store';
import { useConfigContext } from '@/lib/config-provider';
import { matchesKeyboardShortcut, matchesRendererShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { recordTerminalOpened } from '@/lib/terminal-telemetry';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import { AuthModal } from './AuthModal';
import { AutoSyncOnboardingDialog } from './AutoSyncOnboardingDialog';
import { resolveAutoSyncOnboarding } from './auto-sync-onboarding-gate';
import { type PanelTab, TABS } from './DocPanel';
import { EditorArea, type SessionPlacements } from './EditorArea';
import { EditorHeader } from './EditorHeader';
import { composeTerminalSelectionPaste } from './handoff/compose-terminal-selection';
import { requestPreferredSession } from './handoff/preferred-session-events';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';
import {
  type AgentThreadLaunchDetail,
  subscribeToAgentThreadLaunchRequests,
} from './handoff/thread-launch-events';

// Lazy-loaded: these two mounts are the only eager edges into the ACP
// thread-client + thread-event-model chain (and the whole sessions-dock UI),
// which the entry chunk must not carry — the same lazy-panel pattern as
// ThreadView inside the host. Both mount unconditionally below, so the
// dynamic import fires on first render; behavior is deferred by one chunk
// fetch, not gated on user action.
const AgentThreadClientBinder = lazy(() =>
  import('./acp/AgentThreadClientBinder').then((mod) => ({
    default: mod.AgentThreadClientBinder,
  })),
);
const SessionsHost = lazy(() =>
  import('./SessionsHost').then((mod) => ({ default: mod.SessionsHost })),
);

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
  /** Text to write into the launched CLI's input once it is up — NOT submitted.
   *  Used by the ⌘J/⇧⌘J selection-send so the passage is staged for the user to
   *  add to and send themselves. `prompt` stays null so nothing auto-runs.
   *  Consumed by TerminalPanel, gated on the CLI bake actually happening: a
   *  preflight-suppressed launch (bare-shell fallback) drops it, because staged
   *  text in a raw shell would execute line by line. */
  readonly stagePaste?: string;
}

/**
 * Carries a "Start an agent" launch from a UI click (handoff menus) to the
 * sessions dock's thread-hosting host — the ACP twin of {@link TerminalLaunchIntent}.
 * `agentId === ''` means "resolve the default registered agent, or open Configure
 * agents when none is enabled". `nonce` makes each click a distinct one-shot the
 * host acts on exactly once.
 */
export interface ThreadLaunchIntent {
  readonly agentSource: 'registry' | 'custom';
  readonly agentId: string;
  readonly prompt: string | null;
  readonly docName: string | null;
  readonly titleHint: string | null;
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
  // Sign-in requested by a surface with no prop path to this modal — today the
  // share branch-switch dialog's credential-miss toast, which mounts under App.
  // Return the store's value directly: discarding a useSyncExternalStore result
  // lets React Compiler memoize it to the first snapshot, freezing the flag.
  const authPromptPending = useSyncExternalStore(
    authPromptStore.subscribe,
    authPromptStore.getSnapshot,
    () => false,
  );
  useEffect(() => {
    if (!authPromptPending) return;
    // Clear first: the store is the request, not the modal's open state, so
    // leaving it armed would re-fire on every subsequent render and fight a
    // user who closes the modal.
    authPromptStore.clear();
    setAuthInitialStep('auth');
    setAuthModalOpen(true);
  }, [authPromptPending]);
  const [activeTab, setActiveTab] = useState<PanelTab>(TABS[0].id);
  const [autoSyncOnboardingDismissed, setAutoSyncOnboardingDismissed] = useState(false);
  // Bottom-docked terminal — desktop-only (the bridge is absent in the web
  // host, where a real shell is out of scope). Visibility starts hidden; the
  // Cmd/Ctrl+J + View-menu toggle drives this state (wired below).
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  // The terminal feature (dock + header New chat / toggle) needs not just a
  // desktop bridge but one that actually exposes the `terminal` surface — a
  // session-only bridge (some E2E hosts) has none — AND a host that can
  // actually spawn a PTY: `config.ptyAvailable` is false on Windows/Linux
  // (node-pty is not bundled there; terminal dock dark off-mac), where a
  // rendered affordance would only surface a spawn failure. Gate every
  // terminal affordance on both so a control that can't launch never renders.
  const terminalAvailable =
    desktopBridge != null &&
    desktopBridge.terminal != null &&
    desktopBridge.config.ptyAvailable === true;
  const [terminalVisible, setTerminalVisible] = useState(false);
  // The agents panel is independent of the terminal — different edge, different
  // kind, its own toggle (⌘L). Universal: agent threads are server-hosted, so it
  // works on the web host and where pty does not.
  const [agentsVisible, setAgentsVisible] = useState(false);
  // Which launchable CLIs are on PATH (desktop probe, cached ~60s in main).
  // Handed to the sessions host, which folds it into its launcher resolution.
  // Shared with the Ask-X bubble.
  const installedClis = useInstalledClis();
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
  // "Start an agent" launch intent threaded to the dock's thread host — the ACP
  // twin of `terminalLaunch`. Both buses target the one host now.
  const [threadLaunch, setThreadLaunch] = useState<ThreadLaunchIntent | null>(null);
  const threadLaunchNonceRef = useRef(0);
  // The live session hosts are mounted HERE (below), above EditorArea, so a
  // view-kind change — which remounts EditorArea's subtree — can't re-spawn a
  // terminal (the VS Code / Zed pattern: own the terminal above the layout that
  // changes, re-attach the view). EditorArea reports where each panel attaches
  // via onSessionPlacements.
  const [placements, setPlacements] = useState<SessionPlacements>({
    terminal: { container: null, isShowing: false },
    agents: { container: null, isShowing: false },
    editorRegion: null,
  });
  // Monotonic source for the launch nonce. It must survive the hide-clear of
  // `terminalLaunch` below — deriving the next nonce from the prior intent would
  // restart at 1 after a hide, letting two distinct clicks collide on a nonce
  // the dock would then dedup away as a repeat.
  const launchNonceRef = useRef(0);

  // "New chat" with the preferred AI: let the hosts resolve, open, and reveal.
  // Their resolution spans all three families (in-app agent / CLI / bare shell)
  // and honors the Configure-agents toggles; resolving a CLI here instead could
  // only ever produce a CLI, never the in-app agent a user may prefer — and this
  // pane cannot know which panel should end up on screen.
  function launchNewChat() {
    requestPreferredSession();
  }

  // Reveal the agents panel; the host seeds it when it opens empty. Drives the
  // right edge reveal tab and ⌘L; leaves the other panels untouched (all coexist).
  //
  // Seeding is deliberately NOT done here. The host's `seedOnReveal` resolves the
  // whole preferred-AI space (in-app agent / CLI / bare shell, enablement-aware);
  // this pane can only see the CLI slice. Launching from here would set a launch
  // intent that PREEMPTS that seed, forcing a CLI on a user whose preferred AI is
  // an in-app agent.
  function revealAgents() {
    setAgentsVisible(true);
  }

  const syncStatus = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();

  const { activeDocName, activeProvider } = useDocumentContext();

  // Onboarding modal: open once per machine per project when every gate
  // input aligns. Decision logic lives in `resolveAutoSyncOnboarding`, which
  // also forks the prompt variant on the push-permission probe (denied →
  // pull-only), so each input has its own row in the helper's truth table.
  const autoSyncOnboardingVariant = resolveAutoSyncOnboarding({
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

  // ⌘J / ⇧⌘J with an editor selection STAGE that selection into the user's
  // preferred AI instead of toggling — never submitted, so the user can add
  // context and send it themselves. Reads the debounced selection snapshot for the
  // active doc + current mode (the same registry BottomComposer reads — no editor
  // instance needed, so it works even from the OS-captured ⌘J menu accelerator)
  // and composes the same grounded prompt the Ask-AI selection button sends.
  //
  // Which panel it lands in is the HOSTS' call, not this pane's: they own the
  // live session state and both resolve the same preferred AI, so the passage
  // reuses a running CLI in the bottom dock or an open thread in the agents
  // panel, and the winner reveals itself. Resolving here instead would limit ⌘J
  // to the CLI slice this pane can see, ignoring a preferred in-app agent — and
  // this pane cannot know which panel is the right one anyway.
  //
  // Deliberately NOT gated on a terminal being available: the agents panel is
  // universal, so a selection send works on the web host too.
  //
  // Returns true when a selection was staged (caller skips the toggle / new-tab
  // fallback).
  function sendSelectionToTerminal(newTab: boolean): boolean {
    if (activeDocName == null) return false;
    const snapshot = getSelectionContext(activeDocName, editorMode);
    const selectionMarkdown = snapshot?.markdown ?? '';
    if (selectionMarkdown.trim() === '') return false;
    // Trailing soft newlines (\n, not \r — no submit) drop the CLI input caret
    // onto a blank line below the staged passage.
    const staged = `${composeTerminalSelectionPaste(activeDocName, selectionMarkdown)}\n\n`;
    // Raw selected material, not an instruction — written and left for the user
    // to extend and send, on a CLI and on an agent thread alike.
    requestActiveTerminalInput(staged, { newTab, submit: false });
    return true;
  }
  // Effect Events so the once-bound key/menu listeners below read the current
  // closures (fresh activeDocName / editorMode) without re-subscribing.
  const sendSelectionToTerminalEvent = useEffectEvent(sendSelectionToTerminal);
  const launchNewChatEvent = useEffectEvent(() => launchNewChat());

  // Bottom-dock toggle, dual-wired like the DocPanel: on desktop the View →
  // Bottom Dock item's ⌘J/Ctrl+J accelerator is OS-captured and dispatches
  // `toggle-terminal`; the web host has no menu, so a window keydown stands in.
  // With a selection, the chord sends it to the terminal (reusing the active
  // tab) instead of toggling.
  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-terminal') {
        if (sendSelectionToTerminalEvent(false)) return;
        setTerminalVisible((visible) => !visible);
      } else if (action === 'new-terminal') {
        // Terminal menu "New Terminal": reveal the dock (it never hides, unlike
        // the toggle). The dock adds the new tab itself off the same action; this
        // only owns visibility and covers the case where no dock is mounted yet.
        setTerminalVisible(true);
      } else if (action === 'toggle-agent-panel') {
        setAgentsVisible((visible) => !visible);
      }
    });
  }, []);

  // Unlike the ⌘L listener below, this one stays mounted on desktop: ⌃` carries
  // no native accelerator, so the renderer is its only delivery path. ⌘J is
  // filtered out there by `nativeMenuAccelerator` — the menu already dispatches
  // it above, and acting on it here too would toggle twice.
  useEffect(() => {
    const hasNativeMenu = window.okDesktop != null;
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesRendererShortcut(event, 'toggle-terminal-panel', hasNativeMenu)) return;
      if (isOverlayLayerOpen()) return;
      // Claim the chord only when we will actually act on it. A selection send is
      // the whole of ⌘J on a shell-less host; with no selection AND no shell there
      // is nothing to toggle, so let the browser keep its own ⌘J rather than
      // swallowing it for a no-op.
      if (sendSelectionToTerminalEvent(false)) {
        event.preventDefault();
        return;
      }
      if (!terminalAvailable) return;
      event.preventDefault();
      setTerminalVisible((visible) => !visible);
    }
    // Capture phase so a focused xterm textarea can't swallow the chord first —
    // load-bearing for ⌃`, which has to dismiss the dock from inside the terminal.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [terminalAvailable]);

  // ⌘L / Ctrl+L toggles the agents panel. On desktop the View menu item's
  // accelerator is OS-captured and dispatches `toggle-agent-panel` (handled
  // above), so this window keydown is the web host's stand-in. Unlike ⌘J it has
  // no selection-send behavior: a selection goes to whichever panel the user's
  // preferred AI lives in, which the hosts arbitrate off ⌘J.
  //
  // Skipping the desktop host wholesale stays correct only while EVERY binding
  // of the shortcut is menu-delivered. Add one the menu cannot carry — an
  // Electron menu item holds a single accelerator — and that binding becomes
  // undeliverable on desktop, silently. The fix then is to stay mounted and
  // filter by `matchesRendererShortcut`, as the bottom-dock listener above does.
  useEffect(() => {
    if (window.okDesktop != null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesKeyboardShortcut(event, 'toggle-agent-panel')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      setAgentsVisible((visible) => !visible);
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // ⇧⌘J / Ctrl+Shift+J: open a fresh session with the preferred AI. With a
  // selection, that selection is staged into the new session (always fresh, never
  // reusing the active tab); otherwise the hosts open a promptless one. Both paths
  // resolve to whichever AI the user prefers (in-app agent / CLI / bare shell),
  // not a hardcoded CLI, and the panel that owns the resolved kind reveals itself.
  // Renderer-owned on both hosts (no menu item claims ⇧⌘J), capture-phase so a
  // focused xterm can't swallow it. Universal — the agents panel can always answer.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesKeyboardShortcut(event, 'new-terminal-tab')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      if (!sendSelectionToTerminalEvent(true)) launchNewChatEvent();
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // CLI launch — "Open in terminal" from a handoff menu, or the sessions host
  // resolving an Ask AI / selection send to a CLI. Open the dock (the terminal is
  // allowed by default; the gate only blocks a project explicitly opted out) AND
  // carry the text to the session as a fresh one-shot intent. The nonce comes from
  // the monotonic ref, so every click is a strictly increasing, never-reused
  // intent: each one opens its own tab and the dock can dedup re-renders by nonce
  // without dropping a genuinely new launch.
  //
  // `stage` picks which slot the text lands in, and the two are mutually
  // exclusive: `prompt` is baked as a CLI arg and RUNS, `stagePaste` is written
  // into the input and waits. A raw selection send must never auto-run, so it
  // stages.
  useEffect(() => {
    return subscribeToTerminalLaunchRequests((text, cli, { stage }) => {
      setTerminalVisible(true);
      launchNonceRef.current += 1;
      setTerminalLaunch({
        prompt: stage ? null : text,
        cli,
        nonce: launchNonceRef.current,
        stagePaste: stage ? text : undefined,
      });
    });
  }, []);

  // "Start an agent" launch — a handoff-menu click fires a window event naming a
  // catalog agent + the composed prompt. Reveal the AGENTS panel AND carry the
  // intent to its host as a fresh one-shot (the host resolves the agent / opens
  // the catalog and creates the thread). Universal — agent threads are
  // server-hosted, so unlike the terminal bus this one has no desktop gate.
  useEffect(() => {
    return subscribeToAgentThreadLaunchRequests((detail: AgentThreadLaunchDetail) => {
      setAgentsVisible(true);
      threadLaunchNonceRef.current += 1;
      setThreadLaunch({
        agentSource: detail.agentSource,
        agentId: detail.agentId,
        prompt: detail.prompt,
        docName: detail.docName,
        titleHint: detail.titleHint,
        nonce: threadLaunchNonceRef.current,
      });
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
  // "Show Bottom Dock" and "Hide Bottom Dock". Gated on the dock-state restore so the
  // mount-initial `false` can't overwrite main's retained per-window visibility
  // before the restore reads it (the reload re-expand depends on that value).
  // The first push after the restore settles carries the restored — or
  // fresh-launch hidden — visibility. Desktop-only.
  useEffect(() => {
    if (window.okDesktop == null) return;
    if (!dockRestoreSettled) return;
    // Mirror into the renderer store so the Cmd+K palette can show a
    // state-reflecting "Show/Hide Bottom Dock" label (bridge push is main-only).
    // Deliberately behind BOTH gates, unlike the unconditional sibling mirrors
    // in FileSidebar / EditorArea: publishing the mount-initial `false` before
    // the restore settles would flash a wrong palette label on a window whose
    // dock is about to re-expand, and the web host has no terminal (and never
    // settles the gate) so there is no state to mirror.
    setViewMenuState({ terminalVisible });
    window.okDesktop.editor.notifyViewMenuStateChanged({ terminalVisible });
  }, [terminalVisible, dockRestoreSettled]);

  // The agents panel's twin of the push above, behind the same restore gate for
  // the same reason: its retained per-window visibility is what a reloaded window
  // re-expands from, and a mount-initial `false` would overwrite it first.
  useEffect(() => {
    if (window.okDesktop == null) return;
    if (!dockRestoreSettled) return;
    setViewMenuState({ agentPanelVisible: agentsVisible });
    window.okDesktop.editor.notifyViewMenuStateChanged({ agentPanelVisible: agentsVisible });
  }, [agentsVisible, dockRestoreSettled]);

  // Restore both panels' expanded state after a renderer reload: main retains the
  // per-window visibility of each (written by the gated pushes above once this
  // settles), so a reloaded window re-expands whichever were open before the
  // reload. Reads false after a fresh launch (main has no retained state), so
  // both stay hidden. Run-once; only ever expands (never force-hides), so a user
  // toggle that races the restore is never overridden closed. Settling the gate
  // (always, even on a read failure) releases the deferred pushes so the View
  // menu converges. Desktop-only.
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
        if (cancelled) return;
        if (state.agentPanelVisible) setAgentsVisible(true);
        if (!state.terminalVisible) return;
        // The restore — not the user — is driving this reveal; mark it so the
        // adoption telemetry below skips it.
        restoreRevealRef.current = true;
        setTerminalVisible(true);
      })
      .catch((err) => {
        // Leave a breadcrumb instead of swallowing: a restore failure is
        // otherwise indistinguishable from "main had no retained state", and the
        // panels silently stay hidden. Mirrors the list() catch in TerminalDock.
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
    // Capture the viewport anchor while the outgoing editor is still laid out,
    // before the mode flip hides it, so the incoming view can land on the same
    // block. Read-only — it banks a pending navigation, it never edits the doc.
    if (activeDocName && activeProvider && editorMode !== mode) {
      captureModeSwitchAnchor({
        from: editorMode,
        to: mode,
        docName: activeDocName,
        ytext: activeProvider.document.getText('source'),
      });
    }
    setEditorMode(mode);
    // User-initiated change — persist globally. Tool-driven flips (e.g.
    // RAW_MDX_NAV_EVENT → source) are session-only and deliberately do NOT
    // call setPersistedMode.
    setPersistedMode(mode);
  }

  // Effect Events so the once-bound keydown listener below reads the current
  // closures (mode, active doc/provider) without re-subscribing on every change.
  const toggleEditorModeEvent = useEffectEvent(() => {
    handleModeChange(editorMode === 'source' ? 'wysiwyg' : 'source');
  });
  // "View in source" reads the visual editor's caret for the active document, so
  // it means nothing in source mode or with nothing open. One predicate: the
  // Desktop context menu gates its row on the pushed value while the handler
  // re-checks locally, and a drift between them is a row that is offered and
  // then silently does nothing.
  const canViewInSource =
    editorMode === 'wysiwyg' && Boolean(activeDocName) && Boolean(activeProvider);

  const requestViewInSourceEvent = useEffectEvent(() => {
    // The two nullable reads are restated so TypeScript narrows them.
    if (!canViewInSource || !activeDocName || !activeProvider) return;
    const editor = getEditorForDoc(activeDocName);
    if (!editor) return;
    requestViewInSource({
      editor,
      docName: activeDocName,
      ytext: activeProvider.document.getText('source'),
    });
  });

  // Main attaches the native editor context menu to every editable field in the
  // window and sees an editable target, not which surface it belongs to — so
  // without this push the "View in Source" row would ride the composer, every
  // rename field and every dialog input. Desktop-only; it goes over the existing
  // view-menu-state channel rather than teaching main anything about the doc.
  useEffect(() => {
    window.okDesktop?.editor.notifyViewMenuStateChanged({ canViewInSource });
  }, [canViewInSource]);

  // Mode-toggle + view-in-source keyboard commands. Capture phase so a focused
  // editor can't swallow the chord first; both use CmdOrCtrl+Alt+<letter>, clear
  // of the editors' single-modifier bindings. Capture phase is also why the
  // overlay check is needed: the chord is intercepted before an open modal or
  // palette could handle it, so without standing down the editor behind the
  // overlay would flip mode while the user is working in the overlay.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (matchesKeyboardShortcut(event, 'toggle-editor-mode')) {
        if (isOverlayLayerOpen()) return;
        event.preventDefault();
        toggleEditorModeEvent();
        return;
      }
      if (matchesKeyboardShortcut(event, 'view-source-at-cursor')) {
        if (isOverlayLayerOpen()) return;
        event.preventDefault();
        requestViewInSourceEvent();
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // The Desktop editor context menu's "View in Source" routes back over the
  // menu-action bus (not a second bridge listener) and runs the same jump the
  // keyboard command does; the shared guard makes it inert outside WYSIWYG.
  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-source') requestViewInSourceEvent();
    });
  }, []);

  // A "view in source" jump (keyboard, bubble menu, or Desktop menu) banks its
  // landing target, then fires this to request the flip. Session-only — a
  // contextual peek at one doc's source, not a change to the global mode
  // preference, mirroring the raw-MDX flip above.
  useEffect(() => {
    function onViewInSource(e: Event) {
      const detail = (e as CustomEvent<ViewInSourceDetail>).detail;
      if (detail?.docName === activeDocName) setEditorMode('source');
    }
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onViewInSource);
    return () => window.removeEventListener(VIEW_IN_SOURCE_EVENT, onViewInSource);
  }, [activeDocName]);

  return (
    <>
      {/* Binds the agent-thread client's WS URL — mounted once so threads stay
          connected + replayable whether or not the sessions dock is open. */}
      <Suspense fallback={null}>
        <AgentThreadClientBinder />
      </Suspense>
      {/* The editor takes the row's full width. Both session panels live WITHIN
          EditorArea — the terminal below the editor and the agents panel in its
          own right column. Their live hosts mount below, above EditorArea, so a
          placement change never remounts a running session. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorArea
            editorMode={editorMode}
            onModeChange={handleModeChange}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            terminalBridge={terminalAvailable ? desktopBridge : null}
            terminalVisible={terminalVisible}
            onTerminalVisibleChange={setTerminalVisible}
            agentsVisible={agentsVisible}
            onAgentsVisibleChange={setAgentsVisible}
            onSessionPlacements={setPlacements}
            onRevealAgents={revealAgents}
            renderWorkspaceHeader={(tabs) => (
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
              >
                {tabs}
              </EditorHeader>
            )}
          />
        </div>
      </div>
      {/* The agents host mounts UNCONDITIONALLY — agent threads are server-hosted,
          so the panel works on the web host and on Windows/Linux where pty is
          unavailable. The terminal host mounts only where a shell can actually
          spawn (`terminalAvailable` folds in `ptyAvailable`); an empty terminal
          dock on those hosts would be a control that can never do anything. */}
      <Suspense fallback={null}>
        <SessionsHost
          surface="agents-panel"
          bridge={desktopBridge}
          terminalCapable={terminalAvailable}
          visible={agentsVisible}
          onVisibleChange={setAgentsVisible}
          threadLaunch={threadLaunch}
          installedClis={installedClis}
          container={placements.agents.container}
          isShowing={placements.agents.isShowing}
          onRequestEditorFocus={() => placements.editorRegion?.focus()}
        />
      </Suspense>
      {terminalAvailable ? (
        <Suspense fallback={null}>
          <SessionsHost
            surface="terminal-dock"
            bridge={desktopBridge}
            terminalCapable
            visible={terminalVisible}
            onVisibleChange={setTerminalVisible}
            launch={terminalLaunch}
            installedClis={installedClis}
            container={placements.terminal.container}
            isShowing={placements.terminal.isShowing}
            onRequestEditorFocus={() => placements.editorRegion?.focus()}
          />
        </Suspense>
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
        open={autoSyncOnboardingVariant !== null}
        variant={autoSyncOnboardingVariant ?? 'full'}
        onResolved={() => setAutoSyncOnboardingDismissed(true)}
      />
      <TagDialog />
      <EmojiInsertPopover />
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
