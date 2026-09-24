import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isEditableTextDocFile,
  type TerminalCli,
  type TerminalLaunchCommand,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core';
import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
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
import { requestPreviewTabPromotion } from '@/editor/preview-tab-promotion';
import { getSelectionContext, subscribeSelectionContext } from '@/editor/selection-context';
import { editingSurfaceFor } from '@/editor/selection-stats';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { type EditorModeValue, useEditorMode } from '@/editor/use-editor-mode';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '@/editor/view-in-source-event';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { useNoPushPermissionToast } from '@/hooks/use-no-push-permission-toast';
import { useWorktreeAutoSyncNotice } from '@/hooks/use-worktree-autosync-notice';
import { authPromptStore } from '@/lib/auth-prompt-store';
import { useConfigContext } from '@/lib/config-provider';
import { readWebDockSessionOrder } from '@/lib/dock-session-persistence';
import { matchesKeyboardShortcut, matchesRendererShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { RESTORE_SETTLE_TIMEOUT_MS } from '@/lib/restore-settle-timeout';
import { readTerminalPlacement, writeTerminalPlacement } from '@/lib/terminal-placement-store';
import { readTerminalRightWidth, writeTerminalRightWidth } from '@/lib/terminal-right-width-store';
import { recordTerminalOpened } from '@/lib/terminal-telemetry';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import { useSyncStatus } from '@/presence/use-sync-status';
import { AuthModal } from './AuthModal';
import { AutoSyncOnboardingDialog } from './AutoSyncOnboardingDialog';
import { resolveAutoSyncOnboarding } from './auto-sync-onboarding-gate';
import { type PanelTab, TABS } from './DocPanel';
import { EditorArea, type SessionPlacements } from './EditorArea';
import { EditorHeader } from './EditorHeader';
import { EditorModeToggle } from './EditorModeToggle';
import { composeTerminalSelectionPaste } from './handoff/compose-terminal-selection';
import { requestPreferredSession } from './handoff/preferred-session-events';
import {
  subscribeToTerminalCommandRequests,
  type TerminalCommandId,
} from './handoff/terminal-command-events';
import { requestActiveTerminalInput } from './handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from './handoff/terminal-launch-events';
import {
  type AgentThreadLaunchDetail,
  subscribeToAgentThreadLaunchRequests,
} from './handoff/thread-launch-events';

const AgentThreadClientBinder = lazy(() =>
  import('./acp/AgentThreadClientBinder').then((mod) => ({
    default: mod.AgentThreadClientBinder,
  })),
);
const SessionsHost = lazy(() =>
  import('./SessionsHost').then((mod) => ({ default: mod.SessionsHost })),
);

export interface TerminalCliLaunchIntent {
  readonly prompt: string | null;
  readonly cli: TerminalCli;
  readonly nonce: number;
  readonly stagePaste?: string;
  readonly command?: undefined;
  readonly signInThreadId?: string;
}

interface TerminalCommandLaunchIntent {
  readonly prompt: null;
  readonly cli: null;
  readonly nonce: number;
  readonly command: TerminalLaunchCommand;
  readonly label: string;
  readonly stagePaste?: undefined;
  readonly signInThreadId?: string;
}

export type TerminalLaunchIntent = TerminalCliLaunchIntent | TerminalCommandLaunchIntent;

export interface ThreadLaunchIntent {
  readonly agentSource: 'registry' | 'custom';
  readonly agentId: string;
  readonly prompt: string | null;
  readonly docName: string | null;
  readonly titleHint: string | null;
  readonly attachments: readonly AttachmentPart[] | null;
  readonly nonce: number;
}

export type EditorMode = EditorModeValue;

function NoteWindowModeToggle({
  provider,
  editorMode,
  onModeChange,
}: {
  provider: HocuspocusProvider | null;
  editorMode: EditorModeValue;
  onModeChange: (mode: EditorModeValue) => void;
}) {
  const syncStatus = useSyncStatus(provider);
  return (
    <EditorModeToggle
      isSourceMode={editorMode === 'source'}
      onModeChange={onModeChange}
      sourceDisabled={syncStatus !== 'connected' && syncStatus !== 'synced'}
    />
  );
}

interface RestoreVisibilityGate {
  pendingWithhold: boolean;
  levelEstablished: boolean;
  lastLevel: boolean;
}

const RESTORE_UNESTABLISHED_LEVEL = false;

function makeRestoreVisibilityGate(mountLevel: boolean): RestoreVisibilityGate {
  return { pendingWithhold: false, levelEstablished: false, lastLevel: mountLevel };
}

function armRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): void {
  gate.current.pendingWithhold = true;
}

function resetRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): void {
  gate.current.pendingWithhold = false;
  gate.current.levelEstablished = false;
}

function noteRestoreVisibilityLevel(
  gate: { current: RestoreVisibilityGate },
  visible: boolean,
): void {
  if (gate.current.lastLevel === visible) return;
  gate.current.lastLevel = visible;
  gate.current.levelEstablished = true;
}

function consumeRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): boolean {
  if (!gate.current.pendingWithhold) return true;
  gate.current.pendingWithhold = false;
  return gate.current.levelEstablished;
}

interface EditorPaneProps {
  onOpenSearch?: () => void;
}

export function EditorPane({ onOpenSearch }: EditorPaneProps = {}) {
  const [persistedMode, setPersistedMode] = useEditorMode();
  const [editorMode, setEditorMode] = useState<EditorMode>(persistedMode);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialStep, setAuthInitialStep] = useState<'auth' | 'identity'>('auth');
  const authPromptPending = useSyncExternalStore(
    authPromptStore.subscribe,
    authPromptStore.getSnapshot,
    () => false,
  );
  useEffect(() => {
    if (!authPromptPending) return;
    authPromptStore.clear();
    setAuthInitialStep('auth');
    setAuthModalOpen(true);
  }, [authPromptPending]);
  const [activeTab, setActiveTab] = useState<PanelTab>(TABS[0].id);
  const [autoSyncOnboardingDismissed, setAutoSyncOnboardingDismissed] = useState(false);
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const noteWindow = isNoteWindow();
  const terminalAvailable =
    !noteWindow &&
    desktopBridge != null &&
    desktopBridge.terminal != null &&
    desktopBridge.config.ptyAvailable === true;
  const [terminalVisible, setTerminalVisible] = useState<boolean>(RESTORE_UNESTABLISHED_LEVEL);
  const [terminalRestoreRevealNonce, setTerminalRestoreRevealNonce] = useState(0);
  const [terminalPlacement, setTerminalPlacement] = useState<TerminalPlacement>(() =>
    readTerminalPlacement(),
  );
  const [terminalRightWidth, setTerminalRightWidth] = useState(() => readTerminalRightWidth());
  useEffect(() => {
    writeTerminalPlacement(terminalPlacement);
  }, [terminalPlacement]);
  useEffect(() => {
    writeTerminalRightWidth(terminalRightWidth);
  }, [terminalRightWidth]);
  const [agentsVisible, setAgentsVisible] = useState<boolean>(() =>
    desktopBridge == null
      ? (readWebDockSessionOrder('agents')?.agentPanelVisible ?? false)
      : RESTORE_UNESTABLISHED_LEVEL,
  );
  const installedClis = useInstalledClis();
  const [dockRestoreSettled, setDockRestoreSettled] = useState(false);
  const restoreRevealRef = useRef(false);
  const terminalRestoreGateRef = useRef<RestoreVisibilityGate>(
    makeRestoreVisibilityGate(terminalVisible),
  );
  const agentsRestoreGateRef = useRef<RestoreVisibilityGate>(
    makeRestoreVisibilityGate(agentsVisible),
  );
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunchIntent | null>(null);
  const [terminalCommand, setTerminalCommand] = useState<{
    id: TerminalCommandId;
    nonce: number;
  } | null>(null);
  const [threadLaunch, setThreadLaunch] = useState<ThreadLaunchIntent | null>(null);
  const threadLaunchNonceRef = useRef(0);
  const [placements, setPlacements] = useState<SessionPlacements>({
    terminal: { container: null, isShowing: false },
    agents: { container: null, isShowing: false },
    editorRegion: null,
  });
  const launchNonceRef = useRef(0);

  function launchNewChat() {
    requestPreferredSession();
  }

  function revealAgents() {
    setAgentsVisible(true);
  }

  const syncStatus = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();

  const { activeDocName, activeProvider } = useDocumentContext();
  const editingSurface = editingSurfaceFor(activeDocName, editorMode);

  const autoSyncOnboardingVariant = resolveAutoSyncOnboarding({
    autoSyncOnboardingDismissed,
    hasRemote: syncStatus?.hasRemote,
    projectLocalSynced,
    projectSynced,
    projectLocalConfig,
    projectConfig,
    pushPermissionCheckStatus: syncStatus?.pushPermission?.checkStatus,
  });

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

  function sendSelectionToTerminal(newTab: boolean, target?: 'agents'): boolean {
    if (activeDocName == null) return false;
    const snapshot = getSelectionContext(activeDocName, editingSurface);
    const selectionMarkdown = snapshot?.markdown ?? '';
    if (selectionMarkdown.trim() === '') return false;
    const staged = `${composeTerminalSelectionPaste(activeDocName, selectionMarkdown)}\n\n`;
    requestActiveTerminalInput(staged, { newTab, submit: false, target });
    return true;
  }
  const sendSelectionToTerminalEvent = useEffectEvent(sendSelectionToTerminal);
  const sendSelectionToAgentsEvent = useEffectEvent(() => sendSelectionToTerminal(false, 'agents'));
  const launchNewChatEvent = useEffectEvent(() => launchNewChat());

  useEffect(() => {
    if (noteWindow) return;
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-terminal') {
        setTerminalVisible((visible) => !visible);
      } else if (action === 'move-terminal') {
        setTerminalPlacement((placement) => (placement === 'bottom' ? 'right' : 'bottom'));
      } else if (action === 'new-terminal') {
        setTerminalVisible(true);
      } else if (action === 'toggle-agent-panel') {
        if (sendSelectionToAgentsEvent()) return;
        setAgentsVisible((visible) => !visible);
      }
    });
  }, [noteWindow]);

  useEffect(() => {
    const hasNativeMenu = window.okDesktop != null;
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesRendererShortcut(event, 'toggle-terminal-panel', hasNativeMenu)) return;
      if (isOverlayLayerOpen()) return;
      if (!terminalAvailable) return;
      event.preventDefault();
      setTerminalVisible((visible) => !visible);
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [terminalAvailable]);

  useEffect(() => {
    if (window.okDesktop != null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesKeyboardShortcut(event, 'toggle-agent-panel')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      if (sendSelectionToAgentsEvent()) return;
      setAgentsVisible((visible) => !visible);
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

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

  useEffect(() => {
    return subscribeToTerminalCommandRequests((id) => {
      setTerminalVisible(true);
      launchNonceRef.current += 1;
      setTerminalCommand({ id, nonce: launchNonceRef.current });
    });
  }, []);

  useEffect(() => {
    return subscribeToTerminalLaunchRequests((request) => {
      setTerminalVisible(true);
      launchNonceRef.current += 1;
      const nonce = launchNonceRef.current;
      const signIn =
        request.signInThreadId === undefined ? {} : { signInThreadId: request.signInThreadId };
      setTerminalLaunch(
        request.kind === 'command'
          ? {
              prompt: null,
              cli: null,
              command: request.command,
              label: request.label,
              nonce,
              ...signIn,
            }
          : {
              prompt: request.stage ? null : request.prompt,
              cli: request.cli,
              nonce,
              stagePaste: request.stage ? request.prompt : undefined,
              ...signIn,
            },
      );
    });
  }, []);

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
        attachments: detail.attachments ?? null,
        nonce: threadLaunchNonceRef.current,
      });
    });
  }, []);

  useEffect(() => {
    if (!terminalVisible) setTerminalLaunch(null);
  }, [terminalVisible]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    noteRestoreVisibilityLevel(terminalRestoreGateRef, terminalVisible);
    if (!dockRestoreSettled) return;
    if (!consumeRestoreVisibilityGate(terminalRestoreGateRef)) return;
    setViewMenuState({ terminalVisible });
    window.okDesktop.editor.notifyViewMenuStateChanged({ terminalVisible });
  }, [terminalVisible, dockRestoreSettled]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    if (!dockRestoreSettled) return;
    setViewMenuState({ terminalPlacement });
    window.okDesktop.editor.notifyViewMenuStateChanged({ terminalPlacement });
  }, [terminalPlacement, dockRestoreSettled]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    noteRestoreVisibilityLevel(agentsRestoreGateRef, agentsVisible);
    if (!dockRestoreSettled) return;
    if (!consumeRestoreVisibilityGate(agentsRestoreGateRef)) return;
    setViewMenuState({ agentPanelVisible: agentsVisible });
    window.okDesktop.editor.notifyViewMenuStateChanged({ agentPanelVisible: agentsVisible });
  }, [agentsVisible, dockRestoreSettled]);

  useEffect(() => {
    let last: boolean | null = null;
    const publish = () => {
      const snapshot =
        activeDocName === null ? null : getSelectionContext(activeDocName, editingSurface);
      const hasEditorSelection = (snapshot?.markdown ?? '').trim() !== '';
      if (hasEditorSelection === last) return;
      last = hasEditorSelection;
      setViewMenuState({ hasEditorSelection });
      window.okDesktop?.editor.notifyViewMenuStateChanged({ hasEditorSelection });
    };
    publish();
    return subscribeSelectionContext(publish);
  }, [activeDocName, editingSurface]);

  useEffect(() => {
    if (noteWindow) {
      setDockRestoreSettled(true);
      return;
    }
    const bridge = window.okDesktop;
    if (bridge == null) return;
    if (typeof bridge.terminal?.getDockState !== 'function') {
      setDockRestoreSettled(true);
      return;
    }
    let cancelled = false;
    let abandoned = false;
    const restoreDeadline = window.setTimeout(() => {
      abandoned = true;
      armRestoreVisibilityGate(terminalRestoreGateRef);
      armRestoreVisibilityGate(agentsRestoreGateRef);
      console.warn(
        `[dock] dock-state restore exceeded its ${RESTORE_SETTLE_TIMEOUT_MS}ms bound; the agents panel and terminal start closed and only that un-restored level is withheld from the view menu and the dock record, so a later reveal or toggle still publishes`,
      );
      setDockRestoreSettled(true);
    }, RESTORE_SETTLE_TIMEOUT_MS);
    void bridge.terminal
      .getDockState()
      .then((state) => {
        if (cancelled || abandoned) return;
        setAgentsVisible((current) => (current ? current : state.agentPanelVisible === true));
        if (!state.terminalVisible) return;
        restoreRevealRef.current = true;
        setTerminalRestoreRevealNonce((nonce) => nonce + 1);
        setTerminalVisible(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (!abandoned) {
          armRestoreVisibilityGate(terminalRestoreGateRef);
          armRestoreVisibilityGate(agentsRestoreGateRef);
        }
        console.error(
          '[dock] dock-state restore failed; the agents panel and terminal start closed and only that un-restored level is withheld from the view menu and the dock record, so a later reveal or toggle still publishes:',
          err,
        );
      })
      .finally(() => {
        window.clearTimeout(restoreDeadline);
        if (!cancelled) setDockRestoreSettled(true);
      });
    return () => {
      cancelled = true;
      abandoned = true;
      window.clearTimeout(restoreDeadline);
      resetRestoreVisibilityGate(terminalRestoreGateRef);
      resetRestoreVisibilityGate(agentsRestoreGateRef);
    };
  }, [noteWindow]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    if (restoreRevealRef.current) {
      restoreRevealRef.current = false;
      return;
    }
    if (terminalVisible) recordTerminalOpened();
  }, [terminalVisible]);

  useNoPushPermissionToast(syncStatus?.pausedReason);

  useWorktreeAutoSyncNotice();

  function handleModeChange(mode: EditorModeValue) {
    if (activeDocName && activeProvider && editorMode !== mode) {
      captureModeSwitchAnchor({
        from: editorMode,
        to: mode,
        docName: activeDocName,
        ytext: activeProvider.document.getText('source'),
      });
      requestPreviewTabPromotion(activeDocName);
    }
    setEditorMode(mode);
    setPersistedMode(mode);
  }

  const toggleEditorModeEvent = useEffectEvent(() => {
    handleModeChange(editorMode === 'source' ? 'wysiwyg' : 'source');
  });
  const canViewInSource =
    editorMode === 'wysiwyg' && Boolean(activeDocName) && Boolean(activeProvider);

  const requestViewInSourceEvent = useEffectEvent(() => {
    if (!canViewInSource || !activeDocName || !activeProvider) return;
    const editor = getEditorForDoc(activeDocName);
    if (!editor) return;
    requestViewInSource({
      editor,
      docName: activeDocName,
      ytext: activeProvider.document.getText('source'),
    });
  });

  useEffect(() => {
    window.okDesktop?.editor.notifyViewMenuStateChanged({ canViewInSource });
  }, [canViewInSource]);

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

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-source') requestViewInSourceEvent();
    });
  }, []);

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
      {}
      <Suspense fallback={null}>
        <AgentThreadClientBinder />
      </Suspense>
      {}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorArea
            editorMode={editorMode}
            onModeChange={handleModeChange}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            terminalBridge={terminalAvailable ? desktopBridge : null}
            terminalVisible={noteWindow ? false : terminalVisible}
            terminalPlacement={terminalPlacement}
            terminalRightWidth={terminalRightWidth}
            onTerminalVisibleChange={setTerminalVisible}
            onTerminalRightWidthChange={setTerminalRightWidth}
            agentsVisible={noteWindow ? false : agentsVisible}
            onAgentsVisibleChange={setAgentsVisible}
            onSessionPlacements={setPlacements}
            onRevealAgents={noteWindow ? undefined : revealAgents}
            renderWorkspaceHeader={(tabs) => (
              <EditorHeader
                noteModeToggle={
                  noteWindow && activeDocName !== null && !isEditableTextDocFile(activeDocName) ? (
                    <NoteWindowModeToggle
                      provider={activeProvider}
                      editorMode={editorMode}
                      onModeChange={handleModeChange}
                    />
                  ) : null
                }
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
      {}
      {noteWindow ? null : (
        <Suspense fallback={null}>
          <SessionsHost
            surface="agents-panel"
            bridge={desktopBridge}
            terminalCapable={terminalAvailable}
            visible={agentsVisible}
            onVisibleChange={setAgentsVisible}
            agentsVisibilityRestoreSettled={desktopBridge == null || dockRestoreSettled}
            threadLaunch={threadLaunch}
            installedClis={installedClis}
            container={placements.agents.container}
            isShowing={placements.agents.isShowing}
            onRequestEditorFocus={() => placements.editorRegion?.focus()}
          />
        </Suspense>
      )}
      {terminalAvailable ? (
        <Suspense fallback={null}>
          <SessionsHost
            surface="terminal-dock"
            terminalPlacement={terminalPlacement}
            onTerminalPlacementChange={setTerminalPlacement}
            reserveRightRevealTabGutter={terminalPlacement === 'right' && !agentsVisible}
            bridge={desktopBridge}
            terminalCapable
            visible={terminalVisible}
            terminalRestoreRevealNonce={terminalRestoreRevealNonce}
            onVisibleChange={setTerminalVisible}
            launch={terminalLaunch}
            commandLaunch={terminalCommand}
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
      {}
    </>
  );
}
