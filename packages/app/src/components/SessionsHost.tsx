// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  TERMINAL_CLIS,
  type TerminalCli,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core';
import type { ThreadInfo, ThreadStatus } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import { SquareTerminalIcon } from 'lucide-react';
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { ArchivedThreadChooser, ThreadHistoryMenu } from '@/components/acp/ThreadHistoryMenu';
import { publishReusableSession } from '@/components/reusable-session-store';
import { Spinner } from '@/components/ui/spinner';
import { TabsContent } from '@/components/ui/tabs';
import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
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
import {
  getAgentThreadClient,
  useAgentThreadConnection,
  useAgentThreadUnread,
  useArchivedAgentThreads,
  useOpenAgentThreadTabs,
} from '@/lib/acp/thread-client';
import { stageThreadDraft } from '@/lib/acp/thread-draft-staging';
import type { OkDesktopBridge, OkTerminalRestartSnapshot } from '@/lib/desktop-bridge-types';
import {
  type DockSessionOrder,
  type DockSurface,
  readDockRestoreState,
  readDockSessionOrder,
  readWebDockSessionOrder,
  writeDockSessionOrder,
} from '@/lib/dock-session-persistence';
import { matchesPrimaryModifier, type ShortcutPlatform } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
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

function makeSessionId(counter: number): string {
  return `terminal-session-${counter}`;
}

function escapeSelector(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

function focusTerminalSession(id: string) {
  if (id === '') return;
  document
    .querySelector<HTMLElement>(
      `[data-terminal-session="${escapeSelector(id)}"] .xterm-helper-textarea`,
    )
    ?.focus();
}

function focusThreadSession(id: string) {
  if (id === '') return;
  document
    .querySelector<HTMLElement>(
      `[data-session-id="${escapeSelector(id)}"] [data-testid="agent-thread-composer"]`,
    )
    ?.focus();
}

function focusSession(session: SessionDescriptor) {
  if (session.kind === 'terminal') focusTerminalSession(session.id);
  else focusThreadSession(session.id);
}

function focusInsideHost(hostEl: HTMLElement | null): boolean {
  return hostEl?.contains(document.activeElement) ?? false;
}

export type SessionSurface = 'terminal-dock' | 'agents-panel' | 'terminal-window';

function chordTargetsHost(hostEl: HTMLElement | null, isWindow: boolean): boolean {
  return isWindow || focusInsideHost(hostEl);
}

function threadStatusDotClass(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return 'bg-amber-500 animate-pulse';
    case 'installing':
    case 'spawning':
    case 'authenticating':
      return 'bg-sky-500 animate-pulse';
    case 'auth_required':
    case 'awaiting_permission':
      return 'bg-amber-500';
    case 'ready':
      return 'bg-emerald-500';
    case 'error':
      return 'bg-red-500';
    default:
      return 'bg-muted-foreground';
  }
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
            threadStatusDotClass(info.status),
            unread && info.status === 'ready' && 'animate-pulse',
          )}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

interface SessionsHostProps {
  readonly bridge: OkDesktopBridge | null;
  readonly terminalCapable?: boolean;
  readonly surface: SessionSurface;
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

const TERMINAL_RESTORE_TIMEOUT_MS = 5_000;

const TERMINAL_DOCK_KINDS: Record<Exclude<LauncherSelection['kind'], 'thread' | 'none'>, true> = {
  cli: true,
  terminal: true,
  desktop: true,
};

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

  useLayoutEffect(() => {
    if (hostEl == null || container == null) return;
    if (hostEl.parentElement !== container) container.appendChild(hostEl);
  }, [hostEl, container]);

  const canRehydrate = hostTerminals && typeof bridge?.terminal?.list === 'function';

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
  const [rehydrationSettled, setRehydrationSettled] = useState(!canRehydrate);
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
  const restoreAbandonedRef = useRef(false);
  const restoreUnreadRef = useRef(false);
  const persistDeclineLoggedRef = useRef(false);
  const persistSuppressedRef = useRef<() => boolean>(() => false);
  const lastHandledCommandNonceRef = useRef<number | null>(null);
  const prevVisibleRef = useRef(isWindow ? false : visible);
  const consumedRestoreRevealNonceRef = useRef(terminalRestoreRevealNonce);
  const ptyIdBySessionRef = useRef(new Map<string, string>());
  const stripLaunchNonceRef = useRef(0);

  const openThreadTabs = useOpenAgentThreadTabs();
  const archivedThreads = useArchivedAgentThreads();
  const threadConnection = useAgentThreadConnection();
  const threadConnectionDown = threadConnection === 'connecting' || threadConnection === 'closed';
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
  const liveThreadCount = openThreadTabs.filter((info) => info.archived !== true).length;
  const threadInfoById = new Map(openThreadTabs.map((info) => [info.threadId, info]));
  const openThreadIds = new Set(threadInfoById.keys());

  function openArchivedThread(threadId: string) {
    getAgentThreadClient().openArchivedThread(threadId);
  }

  function dockPersistSuppressed(): boolean {
    if (!persistsOrder) return true;
    if (canRehydrate && !rehydrationSettled) return true;
    if (restoreUnreadRef.current) {
      if (!persistDeclineLoggedRef.current) {
        persistDeclineLoggedRef.current = true;
        console.warn(
          '[terminal] dock persistence suppressed for this window: the restore did not complete, so the saved tab set is left untouched',
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
    writeDockSessionOrder(
      bridge,
      persistSurface,
      {
        order,
        activeKey: active != null ? computePersistKey(active, ptyMap) : null,
      },
      buildTerminalRestartSnapshot(sessionsRef.current, activeSessionIdRef.current),
    );
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
  ) {
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

  function openNewChatSession(cli: TerminalCli) {
    stripLaunchNonceRef.current += 1;
    openSession({ prompt: null, cli, nonce: stripLaunchNonceRef.current });
  }

  function launchSelectedNewTab() {
    if (newSessionChoice.kind === 'terminal') openSession(null);
    else if (newSessionChoice.kind === 'cli') openNewChatSession(newSessionChoice.cli);
    else if (newSessionChoice.kind === 'agent' && newSessionChoice.agent != null)
      void launchAgentThread(
        { source: newSessionChoice.agent.source, id: newSessionChoice.agent.id },
        null,
        null,
        null,
      );
    else openAgentSettings();
  }

  function seedOnReveal(): boolean {
    if (hostThreads) {
      if (newSessionChoice.kind !== 'agent' || newSessionChoice.agent == null) return false;
      void launchAgentThread(
        { source: newSessionChoice.agent.source, id: newSessionChoice.agent.id },
        null,
        null,
        null,
      );
      return true;
    }
    if (newSessionChoice.kind === 'terminal') openSession(null);
    else if (newSessionChoice.kind === 'cli') openNewChatSession(newSessionChoice.cli);
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
    if (!visible) onVisibleChange(true);
  }

  function dispatchAskAi({ text, newTab, submit, target }: ActiveTerminalInputDetail) {
    const selection = target === 'agents' ? agentsTargetedSelection : askAiSelection;
    if (target === 'agents') {
      if (!hostThreads) return;
    } else if (!claimsSessionKind(selection.kind)) return;
    if (!visible) onVisibleChange(true);
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
      if (submit) void launchAgentThread(agent, text, null, null, null);
      else void launchAgentThread(agent, null, null, null, text);
    } else if (selection.kind === 'cli') {
      requestTerminalLaunch(text, selection.cli, { stage: !submit });
    } else {
      openAgentSettings();
    }
  }

  function pickNewChatCli(cli: TerminalCli) {
    writePreferBareTerminal(false);
    saveStickyAgent(terminalCliId(cli));
    openNewChatSession(cli);
  }

  function pickNewChatTerminal() {
    writePreferBareTerminal(true);
    openSession(null);
  }

  function pickNewChatAgent(agent: RegisteredAgent) {
    registerAgent(agent);
    writePreferBareTerminal(false);
    saveStickyAgent(threadAgentId(agent));
    void launchAgentThread({ source: agent.source, id: agent.id }, null, null, null);
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

  function reorderSessions(newOrderIds: readonly string[]) {
    setSessions((prev) => {
      if (newOrderIds.length !== prev.length) return prev;
      const byId = new Map(prev.map((session) => [session.id, session]));
      const next: SessionDescriptor[] = [];
      for (const id of newOrderIds) {
        const session = byId.get(id);
        if (session == null) return prev;
        next.push(session);
      }
      if (next.every((session, index) => session === prev[index])) return prev;
      return next;
    });
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

  const moveActiveSessionRef = useRef(moveActiveSession);
  const openSessionRef = useRef(openSession);
  const seedOnRevealRef = useRef(seedOnReveal);
  const dispatchAskAiRef = useRef(dispatchAskAi);
  const revealForReuseRef = useRef(revealForReuse);
  const launchPreferredSessionRef = useRef(launchPreferredSession);

  function closeSession(id: string) {
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) return;
    const session = current[index];
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

  useEffect(() => {
    persistSuppressedRef.current = dockPersistSuppressed;
    openSessionRef.current = openSession;
    seedOnRevealRef.current = seedOnReveal;
    dispatchAskAiRef.current = dispatchAskAi;
    revealForReuseRef.current = revealForReuse;
    launchPreferredSessionRef.current = launchPreferredSession;
    moveActiveSessionRef.current = moveActiveSession;
    activeSessionIdRef.current = activeSessionId;
    sessionsRef.current = sessions;
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
    if (!persistsOrder) return;
    if (!rehydrationSettled) return;
    if (persistSuppressedRef.current()) return;
    const ptyMap = ptyIdBySessionRef.current;
    const order = sessions
      .map((session) => computePersistKey(session, ptyMap))
      .filter((key): key is string => key != null);
    const active = sessions.find((s) => s.id === activeSessionId);
    writeDockSessionOrder(
      bridge,
      persistSurface,
      {
        order,
        activeKey: active != null ? computePersistKey(active, ptyMap) : null,
      },
      buildTerminalRestartSnapshot(sessions, activeSessionId),
    );
  }, [sessions, activeSessionId, persistsOrder, persistSurface, bridge, rehydrationSettled]);

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
      queueMicrotask(() => focusThreadSession(newest));
    }
  }, [openThreadTabs, hostThreads]);

  const prevLiveThreadCountRef = useRef(liveThreadCount);
  useEffect(() => {
    if (!hostThreads) return;
    const previous = prevLiveThreadCountRef.current;
    prevLiveThreadCountRef.current = liveThreadCount;
    if (liveThreadCount > previous && !visible) onVisibleChange(true);
  }, [liveThreadCount, visible, hostThreads, onVisibleChange]);

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
      openSessionRef.current(launch);
      return;
    }
    if (commandLaunch != null && commandLaunch.nonce !== lastHandledCommandNonceRef.current) {
      lastHandledCommandNonceRef.current = commandLaunch.nonce;
      openSessionRef.current(null, commandLaunch.id);
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
    void launchAgentThread(
      agent,
      threadLaunch.prompt,
      threadLaunch.docName,
      threadLaunch.titleHint,
    ).then((outcome) => {
      if (outcome === 'deduped') {
        toast.error(t`Already starting a chat with this agent — try again in a moment.`);
      }
    });
  }, [threadLaunch, hostThreads, effectiveDefaultAgent, t]);

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
        `[terminal] dock restore exceeded its ${TERMINAL_RESTORE_TIMEOUT_MS}ms bound; cold-starting instead of waiting`,
      );
      restoreAbandonedRef.current = true;
      restoreUnreadRef.current = true;
      seedOwedRef.current = true;
      settle();
    }, TERMINAL_RESTORE_TIMEOUT_MS);
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
      seedOwedRef.current = false;
      persistDeclineLoggedRef.current = false;
    };
  }, [bridge, hostTerminals, persistSurface]);

  useEffect(() => {
    if (canRehydrate || !persistsOrder) return;
    if (typeof bridge?.terminal?.getDockState !== 'function') return;
    let cancelled = false;
    void readDockSessionOrder(bridge, persistSurface).then((persisted) => {
      if (cancelled || persisted == null) return;
      reloadOrderRef.current = persisted.order;
      const activationTookOver = pendingActiveKeyRef.current !== null;
      if (!activationTookOver) pendingActiveKeyRef.current = persisted.activeKey;
    });
    return () => {
      cancelled = true;
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
        if (terminalAvailable) openSessionRef.current(null);
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

  useLayoutEffect(() => {
    if (isShowing || visible) return;
    if (!focusInsideHost(hostEl)) return;
    onRequestEditorFocus();
  }, [isShowing, visible, hostEl, onRequestEditorFocus]);

  useEffect(() => {
    if (!isShowing) return;
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (active != null) focusSession(active);
  }, [isShowing]);

  const activeThreadIdForView = (() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    return active?.kind === 'thread' ? active.threadId : null;
  })();
  const activeThreadInfoForView =
    activeThreadIdForView !== null ? threadInfoById.get(activeThreadIdForView) : undefined;
  const activeThreadActivityAt = activeThreadInfoForView?.lastActivityAt ?? null;
  const activeThreadStatus = activeThreadInfoForView?.status ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activeThreadActivityAt` and `activeThreadStatus` are not read inside the effect body — they are dep-only, so an incoming activity tick OR a status transition (running → ready without a fresh activityAt) both re-fire the mark-viewed call. Without the status dep, a ready-flip on an unchanged activityAt would leave the tab pulsing forever.
  useEffect(() => {
    if (!isShowing || activeThreadIdForView === null) return;
    getAgentThreadClient().markThreadViewed(activeThreadIdForView);
  }, [activeThreadIdForView, activeThreadActivityAt, activeThreadStatus, isShowing]);

  const tabDescriptors: TerminalTabDescriptor[] = sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session),
    icon:
      session.kind === 'terminal' ? (
        terminalTabIcon()
      ) : (
        <ThreadTabIcon info={threadInfoById.get(session.threadId)} threadId={session.threadId} />
      ),
  }));

  const panelSessions = [...sessions].sort((a, b) => a.ordinal - b.ordinal);

  const newButton = (
    <TerminalNewChatButton
      selected={newSessionChoice}
      onLaunchSelected={launchSelectedNewTab}
      showAgents={hostThreads}
      registeredAgents={enabledRegisteredAgents}
      onPickAgent={pickNewChatAgent}
      onOpenSettings={openAgentSettings}
      liveThreadCount={liveThreadCount}
      showClis={terminalAvailable}
      onPickCli={pickNewChatCli}
      onPickTerminal={pickNewChatTerminal}
      visibleClis={enabledTerminalClis(enabledOverrides, installedClis ?? {})}
    />
  );

  const trailingControls =
    hostThreads && archivedThreads.length > 0 ? (
      <ThreadHistoryMenu
        archived={archivedThreads}
        openThreadIds={openThreadIds}
        onOpenThread={openArchivedThread}
      />
    ) : null;

  const showStrip = sessions.length > 0 || (visible && !isWindow);

  const sessionViews = showStrip ? (
    <TerminalTabStrip
      sessions={tabDescriptors}
      sessionKind={hostThreads ? 'agent' : 'terminal'}
      activeSessionId={activeSessionId}
      onSelect={(id) => {
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
      onCollapse={isWindow ? undefined : () => onVisibleChange(false)}
      draggable={isWindow}
      className="h-full"
    >
      {sessions.length === 0 ? (
        terminalAvailable ? null : hostThreads && archivedThreads.length > 0 ? (
          <ArchivedThreadChooser archived={archivedThreads} onOpen={openArchivedThread} />
        ) : (
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
                  onTitleChange={(title) => setSessionTitle(session.id, title)}
                  onClose={() => closeSession(session.id)}
                />
              ) : null
            ) : (
              <ThreadPanel
                threadId={session.threadId}
                info={threadInfoById.get(session.threadId)}
                showConnectionBanner={threadConnectionDown && session.id === activeSessionId}
                active={visible && session.id === activeSessionId}
              />
            )}
          </TabsContent>
        ))
      )}
    </TerminalTabStrip>
  ) : null;

  return (
    <>
      {hostEl != null
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
            hostEl,
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
