// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import {
  TERMINAL_CLIS,
  type TerminalCli,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core';
import type { AttachmentPart, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import { SquareTerminalIcon } from 'lucide-react';
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import {
  ThreadHistoryPanel,
  ThreadHistorySearchProvider,
  ThreadHistoryToggle,
} from '@/components/acp/ThreadHistoryPanel';
import { publishReusableSession } from '@/components/reusable-session-store';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TabsContent } from '@/components/ui/tabs';
import {
  HISTORY_PANEL_WIDTH_PX,
  useHistoryPresentationMode,
} from '@/hooks/use-history-presentation-mode';
import { useActivityClock } from '@/lib/acp/activity-clock';
import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { detectedHarnessAgents, useAgentCatalogQuery } from '@/lib/acp/catalog';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import { hasInflightThreadLaunch, launchAgentThread } from '@/lib/acp/launch-agent-thread';
import {
  enabledTerminalClis,
  type LauncherSelection,
  resolveLauncherSelection,
} from '@/lib/acp/launcher-selection';
import {
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  registerAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { formatRelativeActivity } from '@/lib/acp/relative-activity';
import {
  getAgentThreadClient,
  useAgentThreadConnection,
  useAgentThreadScope,
  useAgentThreads,
  useAgentThreadUnread,
  useInitialRosterThreadIds,
  useOpenAgentThreadTabs,
} from '@/lib/acp/thread-client';
import {
  isEmptyThreadDraft,
  readThreadDraft,
  stageThreadDraft,
  type ThreadDraftContent,
} from '@/lib/acp/thread-draft-staging';
import { threadHasUserMessage } from '@/lib/acp/thread-event-model';
import type { OkDesktopBridge, OkTerminalRestartSnapshot } from '@/lib/desktop-bridge-types';
import { emitDiagnosticBreadcrumb } from '@/lib/diagnostic-breadcrumb';
import {
  type DockSessionOrder,
  type DockSurface,
  readDockRestoreState,
  readWebDockSessionOrder,
  writeAgentsPanelLevel,
  writeDockSessionOrder,
} from '@/lib/dock-session-persistence';
import { matchesPrimaryModifier, type ShortcutPlatform } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { RESTORE_SETTLE_TIMEOUT_MS } from '@/lib/restore-settle-timeout';
import { usePreferBareTerminal, writePreferBareTerminal } from '@/lib/terminal-new-tab-store';
import {
  parseStickyCliId,
  saveStickyAgent,
  terminalCliId,
  threadAgentId,
  useStickyAgent,
} from '@/lib/unified-agent-store';
import { openAgentSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import type { TerminalLaunchIntent, ThreadLaunchIntent } from './EditorPane';

const ThreadView = lazy(() =>
  import('@/components/acp/ThreadView').then((mod) => ({ default: mod.ThreadView })),
);

import { sendQueuedCommentsInThread, subscribeSendToOpenChat } from '@/comments/open-chat-send';
import { subscribeToPreferredSessionRequests } from './handoff/preferred-session-events';
import { notifySignInTerminalExited } from './handoff/sign-in-terminal-events';
import type { TerminalCommandId } from './handoff/terminal-command-events';
import {
  type ActiveTerminalInputDetail,
  subscribeToActiveTerminalInput,
} from './handoff/terminal-input-events';
import { requestTerminalLaunch } from './handoff/terminal-launch-events';
import { TerminalGate } from './TerminalGate';
import { TerminalNewChatButton } from './TerminalNewChatButton';
import {
  type SessionPanelEdge,
  type TerminalTabDescriptor,
  TerminalTabStrip,
} from './TerminalTabStrip';

interface BaseSessionDescriptor {
  readonly id: string;
  readonly ordinal: number;
}
interface TerminalSessionDescriptor extends BaseSessionDescriptor {
  readonly kind: 'terminal';
  readonly launch: TerminalLaunchIntent | null;
  readonly commandId: TerminalCommandId | null;
  readonly title: string | null;
  readonly customLabel: string | null;
  readonly adoptPtyId: string | null;
}
interface ThreadSessionDescriptor extends BaseSessionDescriptor {
  readonly kind: 'thread';
  readonly threadId: string;
}
type SessionDescriptor = TerminalSessionDescriptor | ThreadSessionDescriptor;

type SessionOpenProvenance = 'user' | 'restore-seed';

type AgentPaneLaunchRequest = {
  readonly agent: { source: 'registry' | 'custom'; id: string };
  readonly docName?: string | null;
  readonly titleHint?: string | null;
  readonly attachments?: readonly AttachmentPart[];
} & (
  | { readonly prompt?: string | null; readonly stageDraft?: never }
  | { readonly prompt?: never; readonly stageDraft: string | ThreadDraftContent }
);

type EmptyAgentLaunchState = 'idle' | 'launching' | 'deduped' | 'failed';

function applyReorder(
  current: readonly SessionDescriptor[],
  newOrderIds: readonly string[],
): SessionDescriptor[] | null {
  if (newOrderIds.length !== current.length) return null;
  const byId = new Map(current.map((session) => [session.id, session]));
  const next: SessionDescriptor[] = [];
  for (const id of newOrderIds) {
    const session = byId.get(id);
    if (session == null) return null;
    next.push(session);
  }
  if (next.every((session, index) => session === current[index])) return null;
  return next;
}

function makeSessionId(counter: number): string {
  return `terminal-session-${counter}`;
}

function escapeSelector(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

function terminalSessionFocusSelector(id: string): string {
  return `[data-terminal-session="${escapeSelector(id)}"] .xterm-helper-textarea`;
}

function threadSessionFocusSelector(id: string): string {
  return `[data-session-id="${escapeSelector(id)}"] [data-testid="agent-thread-composer"]`;
}

function focusTerminalSession(id: string): boolean {
  if (id === '') return false;
  const terminal = document.querySelector<HTMLElement>(terminalSessionFocusSelector(id));
  terminal?.focus();
  return terminal != null && document.activeElement === terminal;
}

function threadTabFocusElement(id: string): HTMLElement | null {
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  return document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${safeId}"]`);
}

function focusThreadSession(id: string): boolean {
  if (id === '') return false;
  const composer = document.querySelector<HTMLElement>(threadSessionFocusSelector(id));
  composer?.focus();
  if (composer != null && document.activeElement === composer) return true;
  threadTabFocusElement(id)?.focus();
  return false;
}

function focusSession(session: SessionDescriptor): boolean {
  if (session.kind === 'terminal') return focusTerminalSession(session.id);
  return focusThreadSession(session.id);
}

function fallbackSessionFocusElement(session: SessionDescriptor): HTMLElement | null {
  return session.kind === 'thread' ? threadTabFocusElement(session.id) : null;
}

function focusInsideHost(hostEl: HTMLElement | null): boolean {
  return hostEl?.contains(document.activeElement) ?? false;
}

function focusAvailableButton(candidate: HTMLButtonElement | null): HTMLButtonElement | null {
  if (
    candidate == null ||
    candidate.disabled ||
    candidate.tabIndex < 0 ||
    !candidate.isConnected ||
    candidate.closest('[aria-disabled="true"], [hidden], [inert], [aria-hidden="true"]') != null
  ) {
    return null;
  }
  let current: HTMLElement | null = candidate;
  while (current != null) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    current = current.parentElement;
  }
  candidate.focus();
  return document.activeElement === candidate ? candidate : null;
}

function emptyAgentStateFallbackButton(hostEl: HTMLElement): HTMLButtonElement | null {
  return hostEl.querySelector<HTMLButtonElement>('[data-testid="terminal-new-chat"]');
}

export type SessionSurface = 'terminal-dock' | 'agents-panel' | 'terminal-window';

function chordTargetsHost(hostEl: HTMLElement | null, isWindow: boolean): boolean {
  return isWindow || focusInsideHost(hostEl);
}

type ThreadTabState = 'working' | 'needs-you' | 'ready' | 'stopped' | 'closed';

function threadTabState(info: ThreadInfo): ThreadTabState {
  if (info.archived === true) return 'closed';
  switch (info.status) {
    case 'installing':
    case 'spawning':
    case 'authenticating':
    case 'running':
      return 'working';
    case 'auth_required':
    case 'awaiting_permission':
      return 'needs-you';
    case 'ready':
      return 'ready';
    case 'error':
    case 'exited':
      return 'stopped';
    default: {
      const exhaustive: never = info.status;
      return exhaustive;
    }
  }
}

const THREAD_TAB_DOT_CLASSES: Record<ThreadTabState, string> = {
  working: 'bg-sky-500 animate-pulse',
  'needs-you': 'bg-amber-500',
  ready: 'bg-emerald-500',
  stopped: 'bg-red-500',
  closed: 'bg-muted-foreground',
};

function useThreadTabStatus(info: ThreadInfo): string {
  const { t } = useLingui();
  if (info.archived === true) return t`Not running`;
  switch (info.status) {
    case 'installing':
    case 'spawning':
      return t`Starting`;
    case 'authenticating':
      return t`Signing in`;
    case 'auth_required':
      return t`Needs you to sign in`;
    case 'awaiting_permission':
      return t`Waiting for your approval`;
    case 'running':
      return t`Working`;
    case 'ready':
      return t`Ready`;
    case 'error':
      return t`Something went wrong`;
    case 'exited':
      return t`Stopped`;
    default: {
      const exhaustive: never = info.status;
      return exhaustive;
    }
  }
}

function ThreadTabPeek({
  info,
  threadId,
  label,
}: {
  info: ThreadInfo;
  threadId: string;
  label: string;
}): ReactNode {
  const { t } = useLingui();
  const now = useActivityClock();
  const status = useThreadTabStatus(info);
  const unread = useAgentThreadUnread(threadId);
  const lastActivity = formatRelativeActivity(info.lastActivityAt, now);
  return (
    <span className="flex max-w-64 flex-col gap-0.5 text-start">
      <span className="break-words font-medium">{label}</span>
      <span>{status}</span>
      {unread ? <span>{t`New activity`}</span> : null}
      <span className="opacity-70">{t`Last activity ${lastActivity}`}</span>
    </span>
  );
}

function ThreadTabScreenReaderStatus({
  info,
  threadId,
}: {
  info: ThreadInfo;
  threadId: string;
}): ReactNode {
  const { t } = useLingui();
  const status = useThreadTabStatus(info);
  const unread = useAgentThreadUnread(threadId);
  return unread ? t`, ${status}, new activity` : t`, ${status}`;
}

function terminalTabIcon(): ReactNode {
  return (
    <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  );
}

const THREAD_TINT_RINGS: readonly string[] = [
  'ring-violet-400/60',
  'ring-fuchsia-400/60',
  'ring-pink-400/60',
  'ring-cyan-400/60',
  'ring-teal-400/60',
  'ring-lime-400/60',
  'ring-yellow-400/60',
  'ring-stone-400/60',
];

function threadTintClass(threadId: string): string {
  let hash = 5381;
  for (let i = 0; i < threadId.length; i++) {
    hash = ((hash << 5) + hash + threadId.charCodeAt(i)) >>> 0;
  }
  return THREAD_TINT_RINGS[hash % THREAD_TINT_RINGS.length] ?? 'ring-transparent';
}

function ThreadTabIcon({
  info,
  threadId,
}: {
  info: ThreadInfo | undefined;
  threadId: string;
}): ReactNode {
  const unread = useAgentThreadUnread(threadId);
  return (
    <span
      className={cn('relative inline-flex shrink-0 rounded-full ring-1', threadTintClass(threadId))}
    >
      <RegisteredAgentIcon
        agentId={info?.agent.id ?? ''}
        iconUrl={info?.agent.iconUrl}
        className="size-3.5"
      />
      {info != null ? (
        <span
          className={cn(
            '-right-0.5 -bottom-0.5 absolute size-1.5 rounded-full ring-1 ring-background',
            THREAD_TAB_DOT_CLASSES[threadTabState(info)],
            unread && threadTabState(info) === 'ready' && 'animate-pulse',
          )}
          data-thread-state={threadTabState(info)}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

interface SessionsHostSharedProps {
  readonly bridge: OkDesktopBridge | null;
  readonly terminalCapable?: boolean;
  readonly terminalPlacement?: TerminalPlacement;
  readonly onTerminalPlacementChange?: (placement: TerminalPlacement) => void;
  readonly reserveRightRevealTabGutter?: boolean;
  readonly terminalRestoreRevealNonce?: number;
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly launch?: TerminalLaunchIntent | null;
  readonly commandLaunch?: { readonly id: TerminalCommandId; readonly nonce: number } | null;
  readonly threadLaunch?: ThreadLaunchIntent | null;
  readonly installedClis?: Partial<Record<TerminalCli, boolean>>;
  readonly container: HTMLElement | null;
  readonly isShowing: boolean;
  readonly onRequestEditorFocus: () => void;
}

type SessionsHostProps = SessionsHostSharedProps &
  (
    | {
        readonly surface: Extract<SessionSurface, 'agents-panel'>;
        readonly agentsVisibilityRestoreSettled: boolean;
      }
    | {
        readonly surface: Extract<SessionSurface, 'terminal-dock' | 'terminal-window'>;
        readonly agentsVisibilityRestoreSettled?: never;
      }
  );

const REVEAL_FOCUS_LANDING_TIMEOUT_MS = 5_000;

const TERMINAL_DOCK_KINDS: Record<Exclude<LauncherSelection['kind'], 'thread' | 'none'>, true> = {
  cli: true,
  terminal: true,
  desktop: true,
};

function closeHistory(
  setOpen: (open: boolean) => void,
  focus: 'always' | 'if-panel-focused' | 'never',
  panelId: string,
  toggleRef: RefObject<HTMLButtonElement | null>,
) {
  const shouldRestoreFocus =
    focus === 'always' ||
    (focus === 'if-panel-focused' &&
      document.getElementById(panelId)?.contains(document.activeElement) === true);
  setOpen(false);
  if (shouldRestoreFocus) queueMicrotask(() => toggleRef.current?.focus());
}

const MAX_HOST_STATE_REPORTS = 20;

export function SessionsHost({
  bridge,
  terminalCapable = false,
  surface,
  terminalPlacement = 'bottom',
  onTerminalPlacementChange,
  reserveRightRevealTabGutter,
  terminalRestoreRevealNonce = 0,
  visible,
  onVisibleChange,
  agentsVisibilityRestoreSettled,
  launch = null,
  commandLaunch = null,
  threadLaunch = null,
  installedClis,
  container,
  isShowing,
  onRequestEditorFocus,
}: SessionsHostProps) {
  const { t } = useLingui();

  const isWindow = surface === 'terminal-window';
  const hostThreads = surface === 'agents-panel';
  const hostTerminals = !hostThreads;
  const terminalAvailable = hostTerminals && terminalCapable && bridge?.terminal != null;
  const edge: SessionPanelEdge = hostThreads ? 'right' : terminalPlacement;
  const persistSurface: DockSurface = hostThreads ? 'agents' : 'terminal';
  const persistedPanelLevel = hostThreads && visible;
  const persistsOrder = !isWindow;
  const shortcutPlatform: ShortcutPlatform | undefined =
    bridge?.platform === 'darwin'
      ? 'mac'
      : bridge?.platform === 'linux' || bridge?.platform === 'win32'
        ? 'windowsLinux'
        : undefined;

  const [hostEl] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'flex min-h-0 flex-1 flex-col overflow-hidden';
    return el;
  });

  const [attachedHostEl, setAttachedHostEl] = useState<HTMLDivElement | null>(null);
  const hostStateReportsRef = useRef(0);

  useLayoutEffect(() => {
    if (hostEl == null || container == null) return;
    if (hostEl.parentElement !== container) container.appendChild(hostEl);
    setAttachedHostEl(hostEl);
  }, [hostEl, container]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const { mode: historyMode, remeasure: remeasureHistoryMode } = useHistoryPresentationMode(
    container,
    hostThreads,
  );
  const historyPanelId = useId();
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const previousHistoryModeRef = useRef(historyMode);

  useLayoutEffect(() => {
    const previousMode = previousHistoryModeRef.current;
    previousHistoryModeRef.current = historyMode;
    if (historyOpen && previousMode === 'docked' && historyMode === 'cover') {
      closeHistory(setHistoryOpen, 'if-panel-focused', historyPanelId, historyToggleRef);
    }
  }, [historyMode, historyOpen, historyPanelId]);
  const canRehydrate = hostTerminals && typeof bridge?.terminal?.list === 'function';
  const restoresDesktopDockOrder =
    hostThreads && typeof bridge?.terminal?.getDockState === 'function';

  const coldSeedTerminal = !canRehydrate && terminalAvailable && visible;

  const [webReloadOrder] = useState<DockSessionOrder | null>(() => {
    if (canRehydrate || !persistsOrder || coldSeedTerminal) return null;
    return typeof bridge?.terminal?.getDockState === 'function'
      ? null
      : readWebDockSessionOrder(persistSurface);
  });
  const reloadOrderRef = useRef<readonly string[]>(webReloadOrder?.order ?? []);
  const pendingActiveKeyRef = useRef<string | null>(webReloadOrder?.activeKey ?? null);
  const [sessions, setSessions] = useState<readonly SessionDescriptor[]>(() =>
    coldSeedTerminal
      ? [
          {
            kind: 'terminal',
            id: makeSessionId(1),
            launch,
            commandId: null,
            title: null,
            customLabel: null,
            ordinal: 1,
            adoptPtyId: null,
          },
        ]
      : [],
  );
  const [activeSessionId, setActiveSessionId] = useState(() =>
    coldSeedTerminal ? makeSessionId(1) : '',
  );
  const [rehydrationSettled, setRehydrationSettled] = useState(
    !canRehydrate && !restoresDesktopDockOrder,
  );
  const rehydratedRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const sessionCounterRef = useRef(coldSeedTerminal ? 1 : 0);
  const lastHandledLaunchNonceRef = useRef<number | null>(
    coldSeedTerminal && launch ? launch.nonce : null,
  );
  const lastHandledThreadNonceRef = useRef<number | null>(null);
  const settingsShownForNonceRef = useRef<number | null>(null);
  const seedOwedRef = useRef(false);
  const initialVisibleSeedAttemptedRef = useRef(false);
  const [emptyAgentLaunchState, setEmptyAgentLaunchState] = useState<EmptyAgentLaunchState>('idle');
  const pendingAgentLaunchRequestRef = useRef<AgentPaneLaunchRequest | null>(null);
  const retryAgentLaunchRequestRef = useRef<AgentPaneLaunchRequest | null>(null);
  const emptyAgentActionButtonRef = useRef<HTMLButtonElement>(null);
  const revealFocusRef = useRef<{ pendingThreadId: string | null } | null>(null);
  const revealFocusWasShowingRef = useRef(false);
  const retryFocusRequestedRef = useRef(false);
  const restoreAbandonedRef = useRef(false);
  const restoreUnreadRef = useRef(false);
  const userArrangedRef = useRef(false);
  const rosterPopulatedRef = useRef(false);
  const persistDeclineLoggedRef = useRef(false);
  const persistSuppressedRef = useRef<() => boolean>(() => false);
  const lastHandledCommandNonceRef = useRef<number | null>(null);
  const prevVisibleRef = useRef(isWindow ? false : visible);
  const consumedRestoreRevealNonceRef = useRef(terminalRestoreRevealNonce);
  const ptyIdBySessionRef = useRef(new Map<string, string>());
  const stripLaunchNonceRef = useRef(0);

  useLayoutEffect(() => {
    const revealing = isShowing && !revealFocusWasShowingRef.current;
    revealFocusWasShowingRef.current = isShowing;
    if (revealing) revealFocusRef.current = { pendingThreadId: null };
    if (!isShowing) revealFocusRef.current = null;
  }, [isShowing]);

  const openThreadTabs = useOpenAgentThreadTabs();
  const agentThreads = useAgentThreads();
  const threadScope = useAgentThreadScope();
  const threadConnection = useAgentThreadConnection();
  useEffect(() => {
    void threadScope;
    initialVisibleSeedAttemptedRef.current = false;
    pendingAgentLaunchRequestRef.current = null;
    retryAgentLaunchRequestRef.current = null;
    retryFocusRequestedRef.current = false;
    setEmptyAgentLaunchState('idle');
  }, [threadScope]);
  useEffect(() => {
    if (!retryFocusRequestedRef.current) return;
    if (emptyAgentLaunchState !== 'failed' && emptyAgentLaunchState !== 'deduped') return;
    const frame = window.requestAnimationFrame(() => {
      retryFocusRequestedRef.current = false;
      emptyAgentActionButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [emptyAgentLaunchState]);
  useEffect(() => {
    if (hostThreads && !visible && historyOpen)
      closeHistory(setHistoryOpen, 'never', historyPanelId, historyToggleRef);
  }, [historyOpen, historyPanelId, hostThreads, visible]);
  const threadConnectionDown = threadConnection === 'connecting' || threadConnection === 'closed';
  const agentCatalog = useAgentCatalogQuery(hostThreads);
  const registeredAgents = useRegisteredAgents();
  const enabledOverrides = useEnabledOverrides();
  const enabledRegisteredAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(enabledOverrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const effectiveDefaultAgent = pickEffectiveDefaultAgent(
    enabledRegisteredAgents,
    defaultRegisteredAgent,
  );
  const registeredAgentKeys = new Set(
    registeredAgents.map((agent) => `${agent.source}:${agent.id}`),
  );
  const detectedAgentRegistrationPending = detectedHarnessAgents(
    agentCatalog.data?.agents ?? [],
  ).some((agent) => !registeredAgentKeys.has(`${agent.source}:${agent.id}`));
  const refetchAgentCatalog = () => {
    void agentCatalog.refetch();
  };
  const agentCatalogFailed = agentCatalog.isError;
  const agentOptionsSettled = !agentCatalog.isLoading && !detectedAgentRegistrationPending;
  const liveThreadCount = openThreadTabs.filter((info) => info.archived !== true).length;
  const threadInfoById = new Map(openThreadTabs.map((info) => [info.threadId, info]));
  const openThreadIds = new Set(threadInfoById.keys());

  function selectHistoryThread(threadId: string) {
    noteUserArrangement();
    pendingActiveKeyRef.current = null;
    const openSession = sessionsRef.current.find(
      (session) => session.kind === 'thread' && session.threadId === threadId,
    );
    if (openSession != null) {
      setActiveSessionId(openSession.id);
      queueMicrotask(() => focusSession(openSession));
      return;
    }
    getAgentThreadClient().openArchivedThread(threadId);
  }

  function dismissHistory(reason: 'explicit' | 'selection') {
    closeHistory(
      setHistoryOpen,
      reason === 'explicit' ? 'always' : 'never',
      historyPanelId,
      historyToggleRef,
    );
  }

  function setHistoryOpenForPane(open: boolean) {
    if (open) remeasureHistoryMode();
    setHistoryOpen(open);
  }

  function dismissCoveringHistory() {
    if (hostThreads && historyOpen && historyMode === 'cover')
      closeHistory(setHistoryOpen, 'never', historyPanelId, historyToggleRef);
  }

  function dockPersistSuppressed(): boolean {
    if (!persistsOrder) return true;
    if (!rehydrationSettled) return true;
    if (restoreUnreadRef.current && !userArrangedRef.current) {
      if (!persistDeclineLoggedRef.current) {
        persistDeclineLoggedRef.current = true;
        console.warn(
          `[${hostThreads ? 'agents' : 'terminal'}] dock persistence withheld: the restore did not complete, so the saved tab set is left untouched`,
        );
      }
      return true;
    }
    return false;
  }

  function persistDockOrderNow() {
    if (dockPersistSuppressed()) return;
    const ptyMap = ptyIdBySessionRef.current;
    const order = sessionsRef.current
      .map((session) => computePersistKey(session, ptyMap))
      .filter((key): key is string => key != null);
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    const activeKey = active != null ? computePersistKey(active, ptyMap) : null;
    const snapshot = buildTerminalRestartSnapshot(sessionsRef.current, activeSessionIdRef.current);
    if (hostThreads) {
      writeDockSessionOrder(bridge, 'agents', { order, activeKey }, snapshot);
      writeAgentsPanelLevel(bridge, visible);
    } else {
      writeDockSessionOrder(bridge, 'terminal', { order, activeKey }, snapshot);
    }
  }

  function setSessionPtyId(id: string, ptyId: string | null) {
    if (ptyId === null) {
      ptyIdBySessionRef.current.delete(id);
      publishReusableSessionFrom(sessionsRef.current, activeSessionIdRef.current);
      return;
    }
    ptyIdBySessionRef.current.set(id, ptyId);
    publishReusableSessionFrom(sessionsRef.current, activeSessionIdRef.current);
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session != null && session.kind === 'terminal') {
      bridge?.terminal?.setMeta?.(ptyId, {
        ordinal: session.ordinal,
        customLabel: session.customLabel,
      });
    }
    persistDockOrderNow();
  }

  function openSession(
    launchForSession: TerminalLaunchIntent | null,
    commandForSession: TerminalCommandId | null = null,
    provenance: SessionOpenProvenance,
  ) {
    if (provenance === 'user') noteUserArrangement();
    pendingActiveKeyRef.current = null;
    sessionCounterRef.current += 1;
    const id = makeSessionId(sessionCounterRef.current);
    setSessions((prev) => [
      ...prev,
      {
        kind: 'terminal',
        id,
        launch: launchForSession,
        commandId: commandForSession,
        title: null,
        customLabel: null,
        ordinal: sessionCounterRef.current,
        adoptPtyId: null,
      },
    ]);
    setActiveSessionId(id);
  }

  const stickyAgentId = useStickyAgent();
  const preferBareTerminal = usePreferBareTerminal();

  const selection = resolveLauncherSelection({
    sticky: stickyAgentId,
    effectiveThreadAgent: effectiveDefaultAgent,
    enabledClis: enabledTerminalClis(enabledOverrides, installedClis ?? {}),
    enabledDesktopTargets: [],
    installedClis: installedClis ?? {},
    terminalAvailable,
    threadsAvailable: hostThreads,
    desktopSelectable: false,
    preferBareTerminal,
    bareTerminalFallback: true,
  });
  const pickedCli = parseStickyCliId(stickyAgentId);
  const newSessionChoice: NewSessionChoice =
    selection.kind === 'thread'
      ? { kind: 'agent', agent: selection.agent }
      : selection.kind === 'cli'
        ? selection.cli === pickedCli
          ? { kind: 'cli', cli: selection.cli }
          : { kind: 'terminal' }
        : selection.kind === 'terminal'
          ? { kind: 'terminal' }
          : { kind: 'agent', agent: null };

  function openNewChatSession(cli: TerminalCli, provenance: SessionOpenProvenance) {
    stripLaunchNonceRef.current += 1;
    openSession({ prompt: null, cli, nonce: stripLaunchNonceRef.current }, null, provenance);
  }

  function launchAgentForPane(request: AgentPaneLaunchRequest) {
    const {
      agent,
      prompt = null,
      docName = null,
      titleHint = null,
      stageDraft = null,
      attachments,
    } = request;
    const tracksEmptyPane = hostThreads && sessionsRef.current.length === 0;
    const previousPendingRequest = pendingAgentLaunchRequestRef.current;
    if (tracksEmptyPane) {
      pendingAgentLaunchRequestRef.current = request;
      setEmptyAgentLaunchState('launching');
    }
    return launchAgentThread(
      { source: agent.source, id: agent.id },
      prompt,
      docName,
      titleHint,
      stageDraft,
      attachments,
    ).then((outcome) => {
      if (outcome === 'deduped') {
        toast.error(t`Already starting a chat with this agent — try again in a moment.`);
      }
      if (
        !tracksEmptyPane ||
        sessionsRef.current.length > 0 ||
        pendingAgentLaunchRequestRef.current !== request
      )
        return outcome;
      switch (outcome) {
        case 'failed':
          pendingAgentLaunchRequestRef.current = null;
          retryAgentLaunchRequestRef.current = request;
          setEmptyAgentLaunchState('failed');
          return outcome;
        case 'deduped':
          if (previousPendingRequest !== null) {
            pendingAgentLaunchRequestRef.current = previousPendingRequest;
            setEmptyAgentLaunchState('launching');
          } else {
            pendingAgentLaunchRequestRef.current = null;
            retryAgentLaunchRequestRef.current = request;
            setEmptyAgentLaunchState('deduped');
          }
          return outcome;
        case 'started':
          return outcome;
        default:
          return assertNeverThreadLaunchOutcome(outcome);
      }
    });
  }

  function retryFailedAgentLaunch() {
    dismissCoveringHistory();
    retryFocusRequestedRef.current = true;
    const request = retryAgentLaunchRequestRef.current;
    if (request === null) {
      launchSelectedNewTab();
      return;
    }
    void launchAgentForPane(request);
  }

  function launchSelectedNewTab() {
    dismissCoveringHistory();
    if (newSessionChoice.kind === 'terminal') openSession(null, null, 'user');
    else if (newSessionChoice.kind === 'cli') openNewChatSession(newSessionChoice.cli, 'user');
    else if (newSessionChoice.kind === 'agent' && newSessionChoice.agent != null)
      void launchAgentForPane({ agent: newSessionChoice.agent });
    else openAgentSettings();
  }

  function seedOnReveal(): boolean {
    if (hostThreads) {
      if (newSessionChoice.kind !== 'agent' || newSessionChoice.agent == null) return false;
      void launchAgentForPane({ agent: newSessionChoice.agent });
      return true;
    }
    if (newSessionChoice.kind === 'terminal') openSession(null, null, 'restore-seed');
    else if (newSessionChoice.kind === 'cli')
      openNewChatSession(newSessionChoice.cli, 'restore-seed');
    return true;
  }

  const askAiSelection = resolveLauncherSelection({
    sticky: stickyAgentId,
    effectiveThreadAgent: effectiveDefaultAgent,
    enabledClis: enabledTerminalClis(enabledOverrides, installedClis ?? {}),
    enabledDesktopTargets: [],
    installedClis: installedClis ?? {},
    terminalAvailable: terminalCapable,
    threadsAvailable: !isWindow,
    desktopSelectable: false,
    preferBareTerminal: false,
    bareTerminalFallback: false,
  });

  const agentsTargetedSelection = resolveLauncherSelection({
    sticky: stickyAgentId,
    effectiveThreadAgent: effectiveDefaultAgent,
    enabledClis: [],
    enabledDesktopTargets: [],
    installedClis: {},
    terminalAvailable: false,
    threadsAvailable: hostThreads,
    desktopSelectable: false,
    preferBareTerminal: false,
    bareTerminalFallback: false,
  });

  const preferredSessionSelection = resolveLauncherSelection({
    sticky: stickyAgentId,
    effectiveThreadAgent: effectiveDefaultAgent,
    enabledClis: enabledTerminalClis(enabledOverrides, installedClis ?? {}),
    enabledDesktopTargets: [],
    installedClis: installedClis ?? {},
    terminalAvailable: terminalCapable,
    threadsAvailable: !isWindow,
    desktopSelectable: false,
    preferBareTerminal,
    bareTerminalFallback: true,
  });

  function claimsSessionKind(kind: LauncherSelection['kind']): boolean {
    if (isWindow) return true;
    const agentsPanelKind = kind === 'thread' || kind === 'none';
    return hostThreads ? agentsPanelKind : kind in TERMINAL_DOCK_KINDS;
  }

  function publishReusableSessionFrom(sessionList: readonly SessionDescriptor[], activeId: string) {
    const active = sessionList.find((s) => s.id === activeId);
    if (active == null) {
      publishReusableSession(persistSurface, null);
      return;
    }
    if (active.kind === 'thread') {
      const info = threadInfoById.get(active.threadId);
      publishReusableSession(persistSurface, {
        id: active.id,
        kind: 'thread',
        label: info?.agent.name ?? t`the open agent`,
        agentId: info?.agent.id ?? '',
        iconUrl: info?.agent.iconUrl,
      });
      return;
    }
    const livePtyId = ptyIdBySessionRef.current.get(active.id);
    const cli = active.launch?.cli;
    if (livePtyId == null || bridge?.terminal == null || cli == null) {
      publishReusableSession(persistSurface, null);
      return;
    }
    publishReusableSession(persistSurface, {
      id: active.id,
      kind: 'terminal',
      label: TERMINAL_CLIS[cli].displayName,
      cli,
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: publishes from the state it is passed; `openThreadTabs` is a label input, read via threadInfoById
  useEffect(() => {
    publishReusableSessionFrom(sessions, activeSessionId);
  }, [activeSessionId, sessions, openThreadTabs]);

  function revealForReuse() {
    dismissCoveringHistory();
    if (!visible) onVisibleChange(true);
  }

  function dispatchAskAi({ text, newTab, submit, target }: ActiveTerminalInputDetail) {
    const selection = target === 'agents' ? agentsTargetedSelection : askAiSelection;
    if (target === 'agents') {
      if (!hostThreads) return;
    } else if (!claimsSessionKind(selection.kind)) return;
    if (!visible) onVisibleChange(true);
    dismissCoveringHistory();
    const activeId = activeSessionIdRef.current;
    const active = sessionsRef.current.find((s) => s.id === activeId);
    if (!newTab && active != null) {
      if (active.kind === 'thread') {
        stageThreadDraft(active.threadId, text);
        revealForReuse();
        queueMicrotask(() => focusSession(active));
        return;
      }
      const livePtyId = ptyIdBySessionRef.current.get(active.id);
      const terminal = bridge?.terminal;
      if (livePtyId != null && terminal != null && active.launch?.cli != null) {
        terminal.input(livePtyId, text);
        revealForReuse();
        queueMicrotask(() => focusTerminalSession(activeId));
        return;
      }
    }
    if (selection.kind === 'thread') {
      const agent = { source: selection.agent.source, id: selection.agent.id };
      void (submit
        ? launchAgentForPane({ agent, prompt: text })
        : launchAgentForPane({ agent, stageDraft: text }));
    } else if (selection.kind === 'cli') {
      requestTerminalLaunch(text, selection.cli, { stage: !submit });
    } else {
      openAgentSettings();
    }
  }

  function pickNewChatCli(cli: TerminalCli) {
    dismissCoveringHistory();
    writePreferBareTerminal(false);
    saveStickyAgent(terminalCliId(cli));
    openNewChatSession(cli, 'user');
  }

  function pickNewChatTerminal() {
    dismissCoveringHistory();
    writePreferBareTerminal(true);
    openSession(null, null, 'user');
  }

  function unsentActiveThread(): { threadId: string; agent: ThreadInfo['agent'] } | null {
    const active = sessionsRef.current.find((session) => session.id === activeSessionIdRef.current);
    if (active == null || active.kind !== 'thread') return null;
    const info = threadInfoById.get(active.threadId);
    if (info === undefined || info.archived === true) return null;
    const model = getAgentThreadClient().getThreadModel(active.threadId);
    if (model === null) return null;
    if (threadHasUserMessage(model)) return null;
    return { threadId: active.threadId, agent: info.agent };
  }

  function pickNewChatAgent(agent: RegisteredAgent) {
    const unsent = unsentActiveThread();
    if (unsent !== null && switchingThreads.has(unsent.threadId)) return;
    dismissCoveringHistory();
    registerAgent(agent);
    writePreferBareTerminal(false);
    saveStickyAgent(threadAgentId(agent));
    if (unsent === null || (unsent.agent.source === agent.source && unsent.agent.id === agent.id)) {
      void launchAgentForPane({ agent });
      return;
    }
    const draft = readThreadDraft(unsent.threadId);
    if (draft?.uploadsPending === true) {
      void launchAgentForPane({ agent });
      return;
    }
    const request: AgentPaneLaunchRequest =
      draft !== null && !isEmptyThreadDraft(draft) && draft.doc !== null
        ? { agent, stageDraft: { doc: draft.doc, attachments: draft.attachments } }
        : { agent };
    const switchingFrom = unsent.threadId;
    setSwitchingThreads((previous) => new Set(previous).add(switchingFrom));
    void launchAgentForPane(request).then((outcome) => {
      setSwitchingThreads((previous) => {
        if (!previous.has(switchingFrom)) return previous;
        const next = new Set(previous);
        next.delete(switchingFrom);
        return next;
      });
      if (outcome === 'started') getAgentThreadClient().closeThread(switchingFrom);
    });
  }

  function setSessionTitle(id: string, title: string) {
    const next = title.trim() === '' ? null : title.trim();
    setSessions((prev) => {
      if (
        !prev.some(
          (session) => session.id === id && session.kind === 'terminal' && session.title !== next,
        )
      )
        return prev;
      return prev.map((session) =>
        session.id === id && session.kind === 'terminal' ? { ...session, title: next } : session,
      );
    });
  }

  function renameSession(id: string, label: string) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session == null) return;
    if (session.kind === 'thread') {
      getAgentThreadClient().renameThread(session.threadId, label);
      return;
    }
    const next = label.trim() === '' ? null : label.trim();
    setSessions((prev) => {
      if (!prev.some((s) => s.id === id && s.kind === 'terminal' && s.customLabel !== next))
        return prev;
      return prev.map((s) =>
        s.id === id && s.kind === 'terminal' ? { ...s, customLabel: next } : s,
      );
    });
    const ptyId = ptyIdBySessionRef.current.get(id);
    if (ptyId != null) bridge?.terminal?.setMeta?.(ptyId, { customLabel: next });
  }

  function sessionLabel(session: SessionDescriptor): string {
    if (session.kind === 'terminal') {
      return session.customLabel ?? session.title ?? t`Terminal ${session.ordinal}`;
    }
    return threadInfoById.get(session.threadId)?.title ?? t`Agent`;
  }

  const dragActiveRef = useRef(false);
  const announcerRef = useRef<HTMLSpanElement>(null);
  const announceTimerRef = useRef<number | null>(null);

  function noteUserArrangement() {
    if (persistDeclineLoggedRef.current) {
      console.warn(
        `[${hostThreads ? 'agents' : 'terminal'}] dock persistence resumed: a user arrangement established the tab set the restore did not`,
      );
    }
    userArrangedRef.current = true;
    persistDeclineLoggedRef.current = false;
  }

  function reorderSessions(newOrderIds: readonly string[]) {
    if (applyReorder(sessionsRef.current, newOrderIds) != null) noteUserArrangement();
    setSessions((prev) => applyReorder(prev, newOrderIds) ?? prev);
    const orderedPtyIds = newOrderIds
      .map((id) => ptyIdBySessionRef.current.get(id))
      .filter((ptyId): ptyId is string => ptyId != null);
    if (orderedPtyIds.length > 0) bridge?.terminal?.setOrder?.(orderedPtyIds);
  }

  function moveActiveSession(
    direction: -1 | 1,
  ): { label: string; position: number; total: number } | null {
    const current = sessionsRef.current;
    const from = current.findIndex((session) => session.id === activeSessionIdRef.current);
    if (from < 0) return null;
    const to = from + direction;
    if (to < 0 || to >= current.length) return null;
    const ids = current.map((session) => session.id);
    const [movedId] = ids.splice(from, 1);
    ids.splice(to, 0, movedId);
    reorderSessions(ids);
    return { label: sessionLabel(current[from]), position: to + 1, total: current.length };
  }
  function launchPreferredSession() {
    if (!claimsSessionKind(preferredSessionSelection.kind)) return;
    if (!visible) onVisibleChange(true);
    launchSelectedNewTab();
  }

  const noteUserArrangementRef = useRef(noteUserArrangement);
  const moveActiveSessionRef = useRef(moveActiveSession);
  const openSessionRef = useRef(openSession);
  const seedOnRevealRef = useRef(seedOnReveal);
  const launchAgentForPaneRef = useRef(launchAgentForPane);
  const dispatchAskAiRef = useRef(dispatchAskAi);
  const revealForReuseRef = useRef(revealForReuse);
  const launchPreferredSessionRef = useRef(launchPreferredSession);

  function closeSession(id: string) {
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) return;
    noteUserArrangement();
    const session = current[index];
    notifySignInExitOnce(session);
    const isLast = current.length === 1;
    pendingActiveKeyRef.current = null;
    if (id === activeSessionIdRef.current) {
      const neighbor = current[index - 1] ?? current[index + 1];
      const neighborId = neighbor?.id ?? '';
      setActiveSessionId(neighborId);
      if (neighbor != null) queueMicrotask(() => focusSession(neighbor));
    }
    if (session.kind === 'thread') {
      getAgentThreadClient().closeThread(session.threadId);
    } else {
      setSessions(current.filter((s) => s.id !== id));
    }
    if (isLast) {
      onVisibleChange(false);
      onRequestEditorFocus();
    }
  }
  const closeActiveRef = useRef(() => {});
  const signInExitNotifiedRef = useRef(new Set<string>());
  function notifySignInExitOnce(session: (typeof sessionsRef.current)[number] | undefined) {
    if (session == null || session.kind !== 'terminal') return;
    const threadId = session.launch?.signInThreadId;
    if (threadId === undefined || signInExitNotifiedRef.current.has(session.id)) return;
    signInExitNotifiedRef.current.add(session.id);
    notifySignInTerminalExited(threadId);
  }
  const [switchingThreads, setSwitchingThreads] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    persistSuppressedRef.current = dockPersistSuppressed;
    openSessionRef.current = openSession;
    seedOnRevealRef.current = seedOnReveal;
    launchAgentForPaneRef.current = launchAgentForPane;
    dispatchAskAiRef.current = dispatchAskAi;
    revealForReuseRef.current = revealForReuse;
    launchPreferredSessionRef.current = launchPreferredSession;
    noteUserArrangementRef.current = noteUserArrangement;
    moveActiveSessionRef.current = moveActiveSession;
    activeSessionIdRef.current = activeSessionId;
    sessionsRef.current = sessions;
    if (sessions.length > 0) rosterPopulatedRef.current = true;
    closeActiveRef.current = () => {
      const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
      if (active?.kind === 'terminal') {
        closeSession(active.id);
        return;
      }
      const lastTerminal = [...sessionsRef.current].reverse().find((s) => s.kind === 'terminal');
      if (lastTerminal != null) closeSession(lastTerminal.id);
    };
  });

  useEffect(() => {
    if (sessions.length === 0) return;
    pendingAgentLaunchRequestRef.current = null;
    retryAgentLaunchRequestRef.current = null;
    retryFocusRequestedRef.current = false;
    setEmptyAgentLaunchState('idle');
  }, [sessions.length]);

  const initialRosterThreadIds = useInitialRosterThreadIds();

  useEffect(() => {
    if (!persistsOrder) return;
    if (!rehydrationSettled) return;
    if (persistSuppressedRef.current()) return;
    if (
      hostThreads &&
      sessions.length === 0 &&
      !rosterPopulatedRef.current &&
      (initialRosterThreadIds === null || initialRosterThreadIds.size > 0)
    ) {
      writeAgentsPanelLevel(bridge, persistedPanelLevel);
      return;
    }
    const ptyMap = ptyIdBySessionRef.current;
    const order = sessions
      .map((session) => computePersistKey(session, ptyMap))
      .filter((key): key is string => key != null);
    const active = sessions.find((s) => s.id === activeSessionId);
    const activeKey = active != null ? computePersistKey(active, ptyMap) : null;
    const snapshot = buildTerminalRestartSnapshot(sessions, activeSessionId);
    if (hostThreads) {
      writeDockSessionOrder(bridge, 'agents', { order, activeKey }, snapshot);
      writeAgentsPanelLevel(bridge, persistedPanelLevel);
    } else {
      writeDockSessionOrder(bridge, 'terminal', { order, activeKey }, snapshot);
    }
  }, [
    sessions,
    activeSessionId,
    persistsOrder,
    bridge,
    rehydrationSettled,
    persistedPanelLevel,
    hostThreads,
    initialRosterThreadIds,
  ]);

  useEffect(() => {
    if (!hostThreads) return;
    const openIds = new Set(openThreadTabs.map((info) => info.threadId));
    const current = sessionsRef.current;
    const knownThreadIds = new Set(
      current
        .filter((s): s is ThreadSessionDescriptor => s.kind === 'thread')
        .map((s) => s.threadId),
    );
    const additions: ThreadSessionDescriptor[] = [];
    for (const info of openThreadTabs) {
      if (knownThreadIds.has(info.threadId)) continue;
      sessionCounterRef.current += 1;
      additions.push({
        kind: 'thread',
        id: info.threadId,
        threadId: info.threadId,
        ordinal: sessionCounterRef.current,
      });
    }
    const removedAny = current.some((s) => s.kind === 'thread' && !openIds.has(s.threadId));
    if (additions.length === 0 && !removedAny) return;
    setSessions((prev) => {
      const kept = prev.filter((s) => s.kind !== 'thread' || openIds.has(s.threadId));
      const keptThreadIds = new Set(
        kept
          .filter((s): s is ThreadSessionDescriptor => s.kind === 'thread')
          .map((s) => s.threadId),
      );
      const fresh = additions.filter((a) => !keptThreadIds.has(a.threadId));
      const ptyMap = ptyIdBySessionRef.current;
      const next =
        fresh.length > 0
          ? placeSessionAdditions(kept, fresh, reloadOrderRef.current, (s) =>
              computePersistKey(s, ptyMap),
            )
          : kept;
      if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
      return next;
    });
  }, [openThreadTabs, hostThreads]);

  const prevOpenThreadIdsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!hostThreads) return;
    const ids = openThreadTabs.map((info) => info.threadId);
    const previous = prevOpenThreadIdsRef.current;
    prevOpenThreadIdsRef.current = ids;
    if (pendingActiveKeyRef.current != null) return;
    const added = ids.filter((id) => !previous.includes(id));
    const newest = added[added.length - 1];
    if (newest != null) {
      setActiveSessionId(newest);
      if (revealFocusRef.current != null) {
        revealFocusRef.current.pendingThreadId = newest;
      } else {
        queueMicrotask(() => focusThreadSession(newest));
      }
    }
  }, [openThreadTabs, hostThreads]);

  const liveThreadIds = openThreadTabs
    .filter((info) => info.archived !== true)
    .map((info) => info.threadId);
  const prevLiveThreadIdsRef = useRef<readonly string[]>(liveThreadIds);
  useEffect(() => {
    if (!hostThreads) return;
    if (!agentsVisibilityRestoreSettled) return;
    const previous = prevLiveThreadIdsRef.current;
    prevLiveThreadIdsRef.current = liveThreadIds;
    const added = liveThreadIds.filter((id) => !previous.includes(id));
    if (added.length === 0 || visible) return;
    const absorbsReloadSnapshot = added.every((id) => initialRosterThreadIds?.has(id) === true);
    if (!absorbsReloadSnapshot) onVisibleChange(true);
  }, [
    liveThreadIds,
    hostThreads,
    agentsVisibilityRestoreSettled,
    visible,
    initialRosterThreadIds,
    onVisibleChange,
  ]);

  useEffect(() => {
    const pending = pendingActiveKeyRef.current;
    if (pending != null) {
      const ptyMap = ptyIdBySessionRef.current;
      const match = sessions.find((s) => computePersistKey(s, ptyMap) === pending);
      if (match != null) {
        pendingActiveKeyRef.current = null;
        setActiveSessionId(match.id);
        return;
      }
      if (sessions.some((s) => s.id === activeSessionId)) return;
    }
    if (activeSessionId !== '' && sessions.some((s) => s.id === activeSessionId)) return;
    if (sessions.length === 0) {
      if (activeSessionId !== '') setActiveSessionId('');
      return;
    }
    setActiveSessionId(sessions[sessions.length - 1].id);
  }, [sessions, activeSessionId]);

  useEffect(() => {
    if (!rehydrationSettled) return;
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    if (launch != null && launch.nonce !== lastHandledLaunchNonceRef.current) {
      lastHandledLaunchNonceRef.current = launch.nonce;
      openSessionRef.current(launch, null, 'user');
      return;
    }
    if (commandLaunch != null && commandLaunch.nonce !== lastHandledCommandNonceRef.current) {
      lastHandledCommandNonceRef.current = commandLaunch.nonce;
      openSessionRef.current(null, commandLaunch.id, 'user');
      return;
    }
    const threadLaunchPending =
      hostThreads &&
      threadLaunch != null &&
      threadLaunch.nonce !== lastHandledThreadNonceRef.current;
    const restoredVisibility =
      hostTerminals && terminalRestoreRevealNonce !== consumedRestoreRevealNonceRef.current;
    if (restoredVisibility) consumedRestoreRevealNonceRef.current = terminalRestoreRevealNonce;
    if (
      visible &&
      !wasVisible &&
      sessions.length === 0 &&
      !threadLaunchPending &&
      !(hostThreads && hasInflightThreadLaunch())
    ) {
      if (restoredVisibility && !restoreAbandonedRef.current) return;
      seedOwedRef.current = !seedOnRevealRef.current();
      return;
    }
    if (
      hostThreads &&
      visible &&
      wasVisible &&
      !initialVisibleSeedAttemptedRef.current &&
      initialRosterThreadIds !== null
    ) {
      initialVisibleSeedAttemptedRef.current = true;
      if (
        openThreadTabs.length === 0 &&
        sessions.length === 0 &&
        !threadLaunchPending &&
        !hasInflightThreadLaunch()
      ) {
        seedOwedRef.current = !seedOnRevealRef.current();
      }
      return;
    }
    if (!seedOwedRef.current) return;
    if (!visible || sessions.length > 0 || threadLaunchPending) {
      seedOwedRef.current = false;
      return;
    }
    if (hostThreads && effectiveDefaultAgent === null) return;
    if (seedOnRevealRef.current()) seedOwedRef.current = false;
  }, [
    visible,
    launch,
    commandLaunch,
    threadLaunch,
    sessions.length,
    rehydrationSettled,
    hostThreads,
    effectiveDefaultAgent,
    initialRosterThreadIds,
    openThreadTabs.length,
    hostTerminals,
    terminalRestoreRevealNonce,
  ]);

  useEffect(() => {
    if (!hostThreads) return;
    if (threadLaunch == null || threadLaunch.nonce === lastHandledThreadNonceRef.current) return;
    let agent: { source: 'registry' | 'custom'; id: string } | null =
      threadLaunch.agentId === ''
        ? null
        : { source: threadLaunch.agentSource, id: threadLaunch.agentId };
    if (agent === null && effectiveDefaultAgent !== null) {
      agent = { source: effectiveDefaultAgent.source, id: effectiveDefaultAgent.id };
    }
    if (agent === null) {
      if (settingsShownForNonceRef.current !== threadLaunch.nonce) {
        settingsShownForNonceRef.current = threadLaunch.nonce;
        openAgentSettings();
      }
      return;
    }
    lastHandledThreadNonceRef.current = threadLaunch.nonce;
    void launchAgentForPaneRef.current({
      agent,
      prompt: threadLaunch.prompt,
      docName: threadLaunch.docName,
      titleHint: threadLaunch.titleHint,
      attachments: threadLaunch.attachments ?? undefined,
    });
  }, [threadLaunch, hostThreads, effectiveDefaultAgent]);

  useEffect(() => {
    if (!hostTerminals) return;
    if (typeof bridge?.terminal?.list !== 'function') return;
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    let cancelled = false;
    let abandoned = false;
    const settle = () => {
      if (!cancelled) setRehydrationSettled(true);
    };
    const restoreDeadline = window.setTimeout(() => {
      abandoned = true;
      console.warn(
        `[terminal] dock restore exceeded its ${RESTORE_SETTLE_TIMEOUT_MS}ms bound; cold-starting instead of waiting`,
      );
      restoreAbandonedRef.current = true;
      restoreUnreadRef.current = true;
      seedOwedRef.current = true;
      settle();
    }, RESTORE_SETTLE_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(restoreDeadline);
      if (!abandoned) settle();
    };
    void (async () => {
      try {
        const {
          sessionOrder: persisted,
          terminalSnapshot: restartSnapshot,
          failed: restoreReadFailed,
        } = await readDockRestoreState(bridge, persistSurface);
        if (cancelled || abandoned) return;
        if (restoreReadFailed) restoreUnreadRef.current = true;
        if (persisted != null) {
          reloadOrderRef.current = persisted.order;
          pendingActiveKeyRef.current = persisted.activeKey;
        }
        let survivors:
          | readonly {
              ptyId: string;
              customLabel: string | null;
              ordinal: number | null;
            }[]
          | null = null;
        try {
          survivors = (await bridge.terminal.list()) ?? [];
        } catch (err) {
          restoreUnreadRef.current = true;
          console.error(
            `[terminal] reload session list() failed; the surviving shells are unknown: ${String(err)}`,
          );
        }
        if (cancelled) return;
        if (abandoned) {
          const stranded = (survivors ?? []).map((entry) => entry.ptyId);
          if (stranded.length > 0) {
            console.warn(
              `[terminal] dock restore was abandoned before list() resolved; these PTYs stay running unadopted: ${stranded.join(', ')}`,
            );
          }
          return;
        }
        if (survivors != null && survivors.length > 0) {
          const order = reloadOrderRef.current;
          const rankOf = (ptyId: string) => {
            const i = order.indexOf(ptyId);
            return i === -1 ? Number.POSITIVE_INFINITY : i;
          };
          const recovered: TerminalSessionDescriptor[] = survivors
            .map((entry, index) => ({
              kind: 'terminal' as const,
              commandId: null,
              id: makeSessionId(index + 1),
              launch: null,
              title: null,
              customLabel: entry.customLabel ?? null,
              ordinal: entry.ordinal ?? index + 1,
              adoptPtyId: entry.ptyId,
            }))
            .sort((a, b) => {
              const ra = rankOf(a.adoptPtyId);
              const rb = rankOf(b.adoptPtyId);
              return ra === rb ? 0 : ra - rb;
            });
          sessionCounterRef.current = Math.max(
            recovered.length,
            ...recovered.map((r) => r.ordinal),
          );
          setSessions(recovered);
        } else if (
          survivors != null &&
          restartSnapshot != null &&
          restartSnapshot.tabs.length > 0
        ) {
          const recovered = restartSnapshot.tabs.map((entry, index) => ({
            kind: 'terminal' as const,
            commandId: null,
            id: makeSessionId(index + 1),
            launch: null,
            title: null,
            customLabel: entry.customLabel,
            ordinal: entry.ordinal,
            adoptPtyId: null,
          }));
          sessionCounterRef.current = Math.max(
            recovered.length,
            ...recovered.map((r) => r.ordinal),
          );
          pendingActiveKeyRef.current = null;
          setSessions(recovered);
          const active = recovered.find(
            (session) => session.ordinal === restartSnapshot?.activeOrdinal,
          );
          if (active != null) setActiveSessionId(active.id);
        } else if (survivors != null) {
          restoreAbandonedRef.current = true;
          seedOwedRef.current = true;
        }
        window.setTimeout(() => {
          if (!cancelled) pendingActiveKeyRef.current = null;
        }, 9_000);
        finish();
      } catch (err) {
        restoreUnreadRef.current = true;
        restoreAbandonedRef.current = true;
        seedOwedRef.current = true;
        console.error(
          `[terminal] dock rehydration failed; cold-starting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        finish();
      }
    })();
    return () => {
      cancelled = true;
      abandoned = true;
      window.clearTimeout(restoreDeadline);
      rehydratedRef.current = false;
      restoreAbandonedRef.current = false;
      restoreUnreadRef.current = false;
      userArrangedRef.current = false;
      seedOwedRef.current = false;
      persistDeclineLoggedRef.current = false;
    };
  }, [bridge, hostTerminals, persistSurface]);

  useEffect(() => {
    if (canRehydrate || !persistsOrder) return;
    if (typeof bridge?.terminal?.getDockState !== 'function') return;
    let cancelled = false;
    let abandoned = false;
    const settle = () => {
      if (!cancelled) setRehydrationSettled(true);
    };
    const restoreDeadline = window.setTimeout(() => {
      abandoned = true;
      console.warn(
        `[agents] dock order restore exceeded its ${RESTORE_SETTLE_TIMEOUT_MS}ms bound; the saved tab set is left untouched`,
      );
      restoreUnreadRef.current = true;
      settle();
    }, RESTORE_SETTLE_TIMEOUT_MS);
    void readDockRestoreState(bridge, persistSurface)
      .then(({ sessionOrder: persisted, failed: restoreReadFailed }) => {
        if (cancelled || abandoned) return;
        if (restoreReadFailed) restoreUnreadRef.current = true;
        if (persisted != null) {
          reloadOrderRef.current = persisted.order;
          const activationTookOver = pendingActiveKeyRef.current !== null;
          if (!activationTookOver) pendingActiveKeyRef.current = persisted.activeKey;
        }
      })
      .finally(() => {
        window.clearTimeout(restoreDeadline);
        settle();
      });
    return () => {
      cancelled = true;
      window.clearTimeout(restoreDeadline);
      restoreUnreadRef.current = false;
      userArrangedRef.current = false;
      persistDeclineLoggedRef.current = false;
    };
  }, [bridge, canRehydrate, persistsOrder, persistSurface]);

  useEffect(() => {
    if (canRehydrate) return;
    const timer = window.setTimeout(() => {
      pendingActiveKeyRef.current = null;
    }, 9_000);
    return () => window.clearTimeout(timer);
  }, [canRehydrate]);

  useEffect(() => {
    if (!terminalAvailable && !hostThreads) return;
    return subscribeToActiveTerminalInput((detail) => dispatchAskAiRef.current(detail));
  }, [terminalAvailable, hostThreads]);

  useEffect(() => {
    if (!hostThreads) return;
    return subscribeSendToOpenChat(({ threadIds }) => {
      const activeId = activeSessionIdRef.current;
      const active = sessionsRef.current.find((session) => session.id === activeId);
      if (active?.kind !== 'thread') return;
      sendQueuedCommentsInThread(active.threadId, threadIds);
      revealForReuseRef.current();
      queueMicrotask(() => focusSession(active));
    });
  }, [hostThreads]);

  useEffect(() => {
    return subscribeToPreferredSessionRequests(() => launchPreferredSessionRef.current());
  }, []);

  useEffect(() => {
    if (!hostTerminals) return;
    return subscribeLocalMenuAction((action) => {
      if (action === 'new-terminal') {
        if (terminalAvailable) openSessionRef.current(null, null, 'user');
      } else if (action === 'kill-terminal') closeActiveRef.current();
      else if (action === 'close-active-tab-or-window' && isWindow) closeActiveRef.current();
    });
  }, [isWindow, hostTerminals, terminalAvailable]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!matchesPrimaryModifier(event, shortcutPlatform) || event.altKey || event.shiftKey)
        return;
      if (!/^[1-9]$/.test(event.key)) return;
      if (!chordTargetsHost(hostEl, isWindow)) return;
      if (isOverlayLayerOpen()) return;
      const target = sessionsRef.current[Number(event.key) - 1];
      if (target == null) return;
      event.preventDefault();
      event.stopPropagation();
      if (target.id !== activeSessionIdRef.current) noteUserArrangementRef.current();
      setActiveSessionId(target.id);
      queueMicrotask(() => focusSession(target));
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [hostEl, isWindow, shortcutPlatform]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!matchesPrimaryModifier(event, shortcutPlatform) || !event.shiftKey || event.altKey) {
        return;
      }
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (direction === 0) return;
      if (!chordTargetsHost(hostEl, isWindow)) return;
      if (isOverlayLayerOpen()) return;
      if (dragActiveRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.isContentEditable) return;
      const moved = moveActiveSessionRef.current(direction);
      if (moved == null) return;
      event.preventDefault();
      event.stopPropagation();
      const activeId = activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === activeId);
      if (active != null) queueMicrotask(() => focusSession(active));
      const message = t`Moved ${moved.label} to position ${moved.position} of ${moved.total}`;
      if (announceTimerRef.current != null) window.clearTimeout(announceTimerRef.current);
      announceTimerRef.current = window.setTimeout(() => {
        announceTimerRef.current = null;
        if (announcerRef.current != null) announcerRef.current.textContent = message;
      }, 60);
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      if (announceTimerRef.current != null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
  }, [hostEl, isWindow, shortcutPlatform, t]);

  useEffect(() => {
    if (!hostTerminals) return;
    const terminalLive = sessions.some((s) => s.kind === 'terminal');
    setViewMenuState({ terminalLive });
    bridge?.editor.notifyViewMenuStateChanged({ terminalLive });
  }, [bridge, sessions, hostTerminals]);

  const focusInsideHostRef = useRef(false);
  useEffect(() => {
    if (hostEl == null) return;
    const syncFocusSnapshot = () => {
      focusInsideHostRef.current = focusInsideHost(hostEl);
    };
    document.addEventListener('focusin', syncFocusSnapshot, true);
    syncFocusSnapshot();
    return () => document.removeEventListener('focusin', syncFocusSnapshot, true);
  }, [hostEl]);
  useLayoutEffect(() => {
    if (isShowing || visible) return;
    if (!focusInsideHostRef.current) return;
    focusInsideHostRef.current = false;
    onRequestEditorFocus();
  }, [isShowing, visible, onRequestEditorFocus]);

  useEffect(() => {
    if (!isShowing || attachedHostEl == null) return;
    const focusOrigin = document.activeElement;
    const initialTargetId = revealFocusRef.current?.pendingThreadId ?? activeSessionIdRef.current;
    const initialActive = sessionsRef.current.find((s) => s.id === initialTargetId);
    let initialFallbackLanding = false;
    if (initialActive != null) {
      const fallback = fallbackSessionFocusElement(initialActive);
      const preferred = focusSession(initialActive);
      if (preferred) {
        revealFocusRef.current = null;
        return;
      }
      initialFallbackLanding = fallback != null && document.activeElement === fallback;
    }
    const emptySurfaceLanding =
      hostThreads && initialActive == null
        ? (focusAvailableButton(emptyAgentActionButtonRef.current) ??
          focusAvailableButton(emptyAgentStateFallbackButton(attachedHostEl)))
        : null;
    revealFocusRef.current = { pendingThreadId: revealFocusRef.current?.pendingThreadId ?? null };
    let landed = initialFallbackLanding;
    let attemptedFallback: HTMLElement | null = null;
    let retryFrame: number | null = null;
    let retired = false;
    const recordLanding = (event: FocusEvent) => {
      if (event.target === attemptedFallback) landed = true;
    };
    const retryFocus = () => {
      retryFrame = null;
      if (retired) return;
      const targetId = revealFocusRef.current?.pendingThreadId ?? activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === targetId);
      if (active == null) return;
      const focused = document.activeElement;
      const fallback = fallbackSessionFocusElement(active);
      if (
        focused != null &&
        focused !== document.body &&
        focused !== focusOrigin &&
        focused !== fallback &&
        focused !== emptySurfaceLanding
      ) {
        landed = true;
        revealFocusRef.current = null;
        return;
      }
      landed = false;
      attemptedFallback = fallback;
      const preferred = focusSession(active);
      attemptedFallback = null;
      landed = preferred || landed || (fallback != null && document.activeElement === fallback);
      if (preferred) {
        revealFocusRef.current = null;
        observer.disconnect();
      }
    };
    const scheduleRetry = () => {
      if (retired || retryFrame !== null) return;
      retryFrame = window.requestAnimationFrame(retryFocus);
    };
    document.addEventListener('focusin', recordLanding, true);
    const observer = new MutationObserver(() => {
      retryFocus();
      if (!landed) scheduleRetry();
    });
    observer.observe(attachedHostEl, { subtree: true, childList: true });
    scheduleRetry();
    const deadline = window.setTimeout(() => {
      retired = true;
      if (retryFrame != null) window.cancelAnimationFrame(retryFrame);
      retryFrame = null;
      observer.disconnect();
      revealFocusRef.current = null;
      const focusNowhere =
        document.activeElement == null || document.activeElement === document.body;
      const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
      if (!landed && focusNowhere && active != null) {
        console.warn(
          `[${hostThreads ? 'agents' : 'terminal'}] reveal focus did not land within its ${REVEAL_FOCUS_LANDING_TIMEOUT_MS}ms bound`,
        );
      }
    }, REVEAL_FOCUS_LANDING_TIMEOUT_MS);
    return () => {
      retired = true;
      revealFocusRef.current = null;
      document.removeEventListener('focusin', recordLanding, true);
      observer.disconnect();
      if (retryFrame != null) window.cancelAnimationFrame(retryFrame);
      window.clearTimeout(deadline);
    };
  }, [isShowing, attachedHostEl, hostThreads]);

  const activeThreadIdForView = (() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    return active?.kind === 'thread' ? active.threadId : null;
  })();
  const activeThreadInfoForView =
    activeThreadIdForView !== null ? threadInfoById.get(activeThreadIdForView) : undefined;
  const activeThreadActivityAt = activeThreadInfoForView?.lastActivityAt ?? null;
  const activeThreadStatus = activeThreadInfoForView?.status ?? null;
  const historyCovering = hostThreads && historyOpen && historyMode === 'cover';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activeThreadActivityAt` and `activeThreadStatus` are not read inside the effect body — they are dep-only, so an incoming activity tick OR a status transition (running → ready without a fresh activityAt) both re-fire the mark-viewed call. Without the status dep, a ready-flip on an unchanged activityAt would leave the tab pulsing forever. Neither trigger marks anything while `historyCovering` holds: a transcript the history cover hides has not been read, so the effect returns before the call and re-fires once the cover lifts.
  useEffect(() => {
    if (!isShowing || historyCovering || activeThreadIdForView === null) return;
    getAgentThreadClient().markThreadViewed(activeThreadIdForView);
  }, [
    activeThreadIdForView,
    activeThreadActivityAt,
    activeThreadStatus,
    historyCovering,
    isShowing,
  ]);

  const tabDescriptors: TerminalTabDescriptor[] = sessions.map((session) => {
    const label = sessionLabel(session);
    if (session.kind === 'terminal') return { id: session.id, label, icon: terminalTabIcon() };
    const info = threadInfoById.get(session.threadId);
    return {
      id: session.id,
      label,
      icon: <ThreadTabIcon info={info} threadId={session.threadId} />,
      tooltip:
        info === undefined ? undefined : (
          <ThreadTabPeek info={info} threadId={session.threadId} label={label} />
        ),
      tooltipDescription:
        info === undefined
          ? undefined
          : (openedAt) => {
              const lastActivity = formatRelativeActivity(info.lastActivityAt, openedAt);
              return t`Last activity ${lastActivity}`;
            },
      srStatus:
        info === undefined ? undefined : (
          <ThreadTabScreenReaderStatus info={info} threadId={session.threadId} />
        ),
    };
  });

  const panelSessions = [...sessions].sort((a, b) => a.ordinal - b.ordinal);

  const agentPickPending = sessions.some(
    (session) =>
      session.id === activeSessionId &&
      session.kind === 'thread' &&
      switchingThreads.has(session.threadId),
  );

  const newButton = (
    <TerminalNewChatButton
      selected={newSessionChoice}
      onLaunchSelected={launchSelectedNewTab}
      showAgents={hostThreads}
      registeredAgents={enabledRegisteredAgents}
      onPickAgent={pickNewChatAgent}
      agentPickPending={agentPickPending}
      onOpenSettings={openAgentSettings}
      liveThreadCount={liveThreadCount}
      showClis={terminalAvailable}
      onPickCli={pickNewChatCli}
      onPickTerminal={pickNewChatTerminal}
      visibleClis={enabledTerminalClis(enabledOverrides, installedClis ?? {})}
    />
  );

  const historyNewButton = hostThreads ? (
    <TerminalNewChatButton
      selected={newSessionChoice}
      onLaunchSelected={launchSelectedNewTab}
      showAgents
      registeredAgents={enabledRegisteredAgents}
      onPickAgent={pickNewChatAgent}
      agentPickPending={agentPickPending}
      onOpenSettings={openAgentSettings}
      liveThreadCount={liveThreadCount}
      showClis={terminalAvailable}
      onPickCli={pickNewChatCli}
      onPickTerminal={pickNewChatTerminal}
      visibleClis={enabledTerminalClis(enabledOverrides, installedClis ?? {})}
      presentation="panel"
    />
  ) : null;

  const trailingControls = hostThreads ? (
    <ThreadHistoryToggle
      open={historyOpen}
      panelId={historyPanelId}
      triggerRef={historyToggleRef}
      onOpenChange={setHistoryOpenForPane}
    />
  ) : null;

  const showStrip = sessions.length > 0 || (visible && !isWindow);

  useEffect(() => {
    if (!hostTerminals) return;
    if (hostStateReportsRef.current >= MAX_HOST_STATE_REPORTS) return;
    hostStateReportsRef.current += 1;
    emitDiagnosticBreadcrumb('ok-terminal-sessions-host-state', {
      surface,
      sessions: sessions.length,
      hostConnected: hostEl?.isConnected === true,
      hasContainer: container != null,
      attached: attachedHostEl != null,
      terminalVisible: visible,
      showStrip,
      tabs: hostEl?.querySelectorAll('[role="tab"]').length ?? 0,
    });
  }, [
    hostTerminals,
    surface,
    sessions.length,
    hostEl,
    container,
    attachedHostEl,
    visible,
    showStrip,
  ]);
  const emptyAgentStatePreview = readEmptyAgentStatePreview();
  const emptyAgentState =
    emptyAgentStatePreview ??
    (initialRosterThreadIds === null || (effectiveDefaultAgent === null && !agentOptionsSettled)
      ? 'loading'
      : effectiveDefaultAgent === null
        ? agentCatalogFailed
          ? 'agents-unavailable'
          : 'no-agents'
        : emptyAgentStateFromLaunchState(emptyAgentLaunchState));
  const showEmptyAgentState =
    hostThreads && (sessions.length === 0 || emptyAgentStatePreview !== null);

  const sessionContent = showEmptyAgentState ? (
    <EmptyAgentSessionsState
      state={emptyAgentState}
      onConfigureAgents={openAgentSettings}
      onRetry={
        emptyAgentState === 'agents-unavailable' ? refetchAgentCatalog : retryFailedAgentLaunch
      }
      actionButtonRef={emptyAgentActionButtonRef}
    />
  ) : sessions.length === 0 ? (
    terminalAvailable ? null : (
      <EmptySessionsState />
    )
  ) : (
    panelSessions.map((session) => (
      <TabsContent
        key={session.id}
        value={session.id}
        forceMount
        data-session-id={session.id}
        {...(session.kind === 'terminal' ? { 'data-terminal-session': session.id } : {})}
        className={cn(
          'm-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden',
          isWindow && 'px-[22px] pb-[22px]',
        )}
      >
        {session.kind === 'terminal' ? (
          bridge != null && terminalAvailable ? (
            <TerminalGate
              bridge={bridge}
              launch={session.launch}
              commandId={session.commandId}
              adoptPtyId={session.adoptPtyId}
              onPtyId={(ptyId) => setSessionPtyId(session.id, ptyId)}
              onExit={
                session.launch?.signInThreadId === undefined
                  ? undefined
                  : () => notifySignInExitOnce(session)
              }
              onTitleChange={(title) => setSessionTitle(session.id, title)}
              onClose={() => closeSession(session.id)}
            />
          ) : null
        ) : (
          <ThreadPanel
            threadId={session.threadId}
            info={threadInfoById.get(session.threadId)}
            showConnectionBanner={threadConnectionDown && session.id === activeSessionId}
            active={visible && !historyCovering && session.id === activeSessionId}
          />
        )}
      </TabsContent>
    ))
  );

  const historyPanel = historyOpen ? (
    <ThreadHistoryPanel
      threads={agentThreads}
      openThreadIds={openThreadIds}
      activeThreadId={activeThreadIdForView}
      onSelectThread={selectHistoryThread}
      mode={historyMode}
      panelId={historyPanelId}
      onDismiss={dismissHistory}
      newChatControl={historyNewButton}
    />
  ) : null;

  const sessionStrip = (
    <TerminalTabStrip
      sessions={tabDescriptors}
      sessionKind={hostThreads ? 'agent' : 'terminal'}
      activeSessionId={activeSessionId}
      onSelect={(id) => {
        if (id !== activeSessionIdRef.current) noteUserArrangement();
        pendingActiveKeyRef.current = null;
        setActiveSessionId(id);
      }}
      onTabActivate={(id) => {
        const session = sessionsRef.current.find((s) => s.id === id);
        if (session != null) queueMicrotask(() => focusSession(session));
      }}
      newButton={newButton}
      trailingControls={trailingControls}
      onClose={closeSession}
      onRename={renameSession}
      onReorder={reorderSessions}
      onDragActiveChange={(active) => {
        dragActiveRef.current = active;
      }}
      edge={edge}
      onPlacementChange={surface === 'terminal-dock' ? onTerminalPlacementChange : undefined}
      reserveRightRevealTabGutter={reserveRightRevealTabGutter}
      onCollapse={
        isWindow
          ? undefined
          : () => {
              onVisibleChange(false);
              onRequestEditorFocus();
            }
      }
      draggable={isWindow}
      className="h-full"
    >
      {hostThreads ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{sessionContent}</div>
      ) : (
        sessionContent
      )}
    </TerminalTabStrip>
  );

  const sessionViews = showStrip ? (
    hostThreads ? (
      <ThreadHistorySearchProvider scope={threadScope}>
        <div
          className="relative flex h-full min-h-0 min-w-0 overflow-hidden"
          data-testid="agent-panel-layout"
        >
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-testid="agent-panel-session-surface"
            inert={historyCovering ? true : undefined}
          >
            {sessionStrip}
          </div>
          {historyOpen ? (
            <div
              className={cn(
                'z-20 h-full max-w-full bg-background',
                historyMode === 'cover'
                  ? 'absolute inset-0 w-full shadow-xl'
                  : 'w-(--history-panel-width) shrink-0 border-s',
              )}
              style={
                {
                  '--history-panel-width': `${HISTORY_PANEL_WIDTH_PX}px`,
                } as CSSProperties
              }
              data-testid="agent-thread-history-surface"
            >
              {historyPanel}
            </div>
          ) : null}
        </div>
      </ThreadHistorySearchProvider>
    ) : (
      sessionStrip
    )
  ) : null;

  return (
    <>
      {attachedHostEl != null
        ? createPortal(
            <>
              {sessionViews}
              <span
                ref={announcerRef}
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="terminal-reorder-announcer"
              />
            </>,
            attachedHostEl,
          )
        : null}
    </>
  );
}

function ThreadPanel({
  threadId,
  info,
  showConnectionBanner,
  active,
}: {
  threadId: string;
  info: ThreadInfo | undefined;
  showConnectionBanner: boolean;
  active: boolean;
}) {
  if (info === undefined) return null;
  return (
    <>
      {showConnectionBanner ? <ThreadConnectionBanner /> : null}
      <Suspense
        fallback={
          <div
            role="status"
            aria-busy="true"
            className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
          >
            <Spinner className="size-5" aria-hidden="true" />
          </div>
        }
      >
        <ThreadView key={threadId} info={info} active={active} />
      </Suspense>
    </>
  );
}

function ThreadConnectionBanner() {
  const { t } = useLingui();
  return (
    <div
      className="shrink-0 border-amber-500/30 border-b bg-amber-500/5 px-3 py-1 text-amber-700 text-xs dark:text-amber-400"
      data-testid="agent-thread-reconnecting"
    >
      {t`Reconnecting to the agent service…`}
    </div>
  );
}

function EmptySessionsState() {
  const { t } = useLingui();
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm"
      data-testid="sessions-dock-empty"
    >
      {t`Start a chat with the ＋ button, or launch an agent from a page.`}
    </div>
  );
}

function EmptyAgentSessionsState({
  state,
  onConfigureAgents,
  onRetry,
  actionButtonRef,
}: {
  state: EmptyAgentState;
  onConfigureAgents: () => void;
  onRetry: () => void;
  actionButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useLingui();
  let content: ReactNode;
  switch (state) {
    case 'idle':
      content = null;
      break;
    case 'loading':
    case 'starting':
      content = (
        <div
          role="status"
          aria-busy="true"
          className="flex items-center gap-2"
          data-testid="sessions-dock-loading"
        >
          <span aria-hidden="true">
            <Spinner className="size-4" />
          </span>
          <span>{state === 'loading' ? t`Loading agents…` : t`Starting the agent…`}</span>
        </div>
      );
      break;
    case 'no-agents':
      content = (
        <div className="flex flex-col items-center gap-2" data-testid="sessions-dock-no-agents">
          <p>{t`No agents enabled.`}</p>
          <Button ref={actionButtonRef} type="button" size="sm" onClick={onConfigureAgents}>
            {t`Configure agents`}
          </Button>
        </div>
      );
      break;
    case 'agents-unavailable':
      content = (
        <div
          className="flex flex-col items-center gap-2"
          data-testid="sessions-dock-agents-unavailable"
        >
          <p>{t`Couldn't load your agents.`}</p>
          <Button ref={actionButtonRef} type="button" size="sm" onClick={onRetry}>
            {t`Try again`}
          </Button>
        </div>
      );
      break;
    case 'failed':
      content = (
        <div className="flex flex-col items-center gap-2" data-testid="sessions-dock-launch-failed">
          <p>{t`Couldn't start the agent thread.`}</p>
          <Button ref={actionButtonRef} type="button" size="sm" onClick={onRetry}>
            {t`Try again`}
          </Button>
        </div>
      );
      break;
    case 'deduped':
      content = (
        <div
          className="flex flex-col items-center gap-2"
          data-testid="sessions-dock-launch-deduped"
        >
          <p>{t`Already starting a chat with this agent — try again in a moment.`}</p>
          <Button ref={actionButtonRef} type="button" size="sm" onClick={onRetry}>
            {t`Try again`}
          </Button>
        </div>
      );
      break;
    default:
      content = assertNeverEmptyAgentState(state);
  }
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm"
      data-testid="sessions-dock-empty"
    >
      {content}
    </div>
  );
}

type EmptyAgentState =
  | 'idle'
  | 'loading'
  | 'starting'
  | 'deduped'
  | 'no-agents'
  | 'agents-unavailable'
  | 'failed';

const EMPTY_AGENT_STATES: readonly EmptyAgentState[] = [
  'loading',
  'starting',
  'deduped',
  'no-agents',
  'agents-unavailable',
  'failed',
];

function readEmptyAgentStatePreview(): EmptyAgentState | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const state = new URLSearchParams(window.location.search).get('preview-agent-empty');
  return EMPTY_AGENT_STATES.find((candidate) => candidate === state) ?? null;
}

function assertNeverThreadLaunchOutcome(outcome: never): never {
  throw new Error(`unhandled thread launch outcome: ${String(outcome)}`);
}

function assertNeverEmptyAgentState(state: never): never {
  throw new Error(`unhandled empty agent state: ${String(state)}`);
}

function emptyAgentStateFromLaunchState(state: EmptyAgentLaunchState): EmptyAgentState {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'launching':
      return 'starting';
    case 'deduped':
      return 'deduped';
    case 'failed':
      return 'failed';
    default:
      return assertNeverEmptyAgentLaunchState(state);
  }
}

function assertNeverEmptyAgentLaunchState(state: never): never {
  throw new Error(`unhandled empty agent launch state: ${String(state)}`);
}

function computePersistKey(
  session: SessionDescriptor,
  ptyMap: ReadonlyMap<string, string>,
): string | null {
  if (session.kind === 'thread') return session.threadId;
  return session.adoptPtyId ?? ptyMap.get(session.id) ?? null;
}

function buildTerminalRestartSnapshot(
  sessions: readonly SessionDescriptor[],
  activeSessionId: string,
): OkTerminalRestartSnapshot {
  const terminals = sessions.filter(
    (session): session is TerminalSessionDescriptor => session.kind === 'terminal',
  );
  const active = terminals.find((session) => session.id === activeSessionId);
  return {
    tabs: terminals.map((session) => ({
      ordinal: session.ordinal,
      customLabel: session.customLabel,
    })),
    activeOrdinal: active?.ordinal ?? null,
  };
}

function placeSessionAdditions<T extends { readonly id: string }>(
  kept: readonly T[],
  additions: readonly T[],
  order: readonly string[],
  keyOf: (session: T) => string | null,
): T[] {
  const rankOf = (session: T): number => {
    const key = keyOf(session);
    if (key == null) return Number.POSITIVE_INFINITY;
    const i = order.indexOf(key);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const result = [...kept];
  for (const addition of additions) {
    const addRank = rankOf(addition);
    if (addRank === Number.POSITIVE_INFINITY) {
      result.push(addition);
      continue;
    }
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      if (rankOf(result[i]) > addRank) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, addition);
  }
  return result;
}
